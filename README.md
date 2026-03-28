# Jira-Triggered AI Test Generation Agent

Deterministic .NET 10 orchestrator for Jira-triggered test case generation. The current implementation covers webhook intake, request normalization, Jira retrieval, explicit Confluence retrieval, Azure DevOps diff and neighboring test retrieval, generation-context assembly, and scenario generation behind replaceable LLM gateways.

## Flow Overview

The current runtime flow is:

![Gateway flow](docs/flow.png)

Stage behavior in practice:

- `POST /api/runs` accepts a Jira Automation-style request, enforces bearer-token auth, assigns a correlation ID, persists the run, and enqueues background execution.
- `RequestNormalized` resolves defaults, validates enum-like inputs, extracts explicit Confluence links, and keeps non-allowed documentation links as warnings instead of silently widening retrieval.
- `JiraContextCollected` fetches the Jira issue narrative, labels, priority, linked issue keys, and selected comments.
- `ConfluenceResolved` resolves explicit page links only. There is no Confluence search or broad fallback mode in iteration 1.
- `RepositoryResolved` determines the repository target from the configured alias and Jira development-panel pull requests with deterministic rules.
- `CodeContextCollected` fetches changed files from Azure DevOps, skips folder entries without consuming the changed-file limit, builds bounded unified diff previews for text files, and collects neighboring test exemplars.
- `ContextBundleBuilt` assembles the prompt-safe context package from Jira, Confluence, repository diff, and neighboring tests.
- `ScenariosGenerated` calls the configured LLM gateway, validates the returned JSON contract, and stores scenario artifacts on the run.
- `GET /api/runs/{runId}` and `GET /api/runs/{runId}/artifacts` expose the resulting state, warnings, and artifacts.

## Repository Structure

```text
testing-agent-gateway/
|- .azure/
|  `- pipeline-app.yaml
|- agent-runtime/
|  |- README.md
|  `- agent-personality.md
|- docs/
|  |- flow.png
|  `- flow.svg
|- implementation-plan/
|  |- 00-agent-instructions.md
|  |- 01-scope-and-decisions.md
|  |- 02-jira-custom-fields-and-automation.md
|  |- 03-end-to-end-workflow.md
|  |- 04-dotnet-solution-design.md
|  |- 05-api-contracts-and-payloads.md
|  |- 06-generation-pipeline-and-prompts.md
|  |- 07-implementation-backlog.md
|  `- iteration1-agent-blueprint-complete.md
|- infra/
|  |- pipelines/
|  `- terraform/
|- src/
|  |- Manso.Api/
|  |- Manso.Application/
|  |- Manso.Domain/
|  |- Manso.Infrastructure/
|  |- tests/
|  |  |- Manso.UnitTests/
|  |  `- Manso.IntegrationTests/
|  `- Manso.sln
|- AGENTS.md
|- global.json
`- README.md
```

## Application

### Manso.sln

The runnable solution is `src/Manso.sln` and targets `.NET 10`.

Projects:

| Project | Responsibility |
|-------|-------------|
| `src/Manso.Api` | HTTP API, middleware, endpoint mapping, startup wiring |
| `src/Manso.Application` | orchestration services, normalization, retrieval contracts, generation-context assembly |
| `src/Manso.Domain` | immutable workflow DTOs and run models |
| `src/Manso.Infrastructure` | Jira, Confluence, Azure DevOps, persistence, background execution, LLM gateways |
| `src/tests/Manso.UnitTests` | unit coverage for normalization, retrieval, context assembly, SCM behavior |
| `src/tests/Manso.IntegrationTests` | end-to-end API coverage for auth, intake, and background completion |

### API Surface

The current API surface is:

| Route | Description |
|-------|-------------|
| `POST /api/runs` | Starts a run and returns `202 Accepted` |
| `GET /api/runs/{runId}` | Returns run status, stages, warnings, errors, and repository references |
| `GET /api/runs/{runId}/artifacts` | Returns artifact metadata for generated outputs |
| `GET /health/live` | Liveness probe |
| `GET /health/ready` | Readiness probe |

### Current Setup Notes

- The repository is pinned to `10.0.100` via [global.json](global.json).
- The Docker build is validated with `src/Manso.Api/Dockerfile` and produces `testing-agent-gateway:manso-net10`.
- The current local verification baseline is:
  - 31 unit tests passed
  - 6 integration tests passed
  - `dotnet restore`, `build`, `test`, `publish`, and `docker build` succeeded
- PostgreSQL is the default run store; development and tests can switch to `InMemory`.
- Development and test configs default the LLM provider to deterministic mock behavior unless explicitly changed.
- The first configured repository alias is `bank-otp-api`.
- The implemented slice stops after scenario generation. Jira publishing, executable test generation, validation-before-write, and draft PR creation are still pending.

### Configuration Surface

The main configuration groups currently used by the application are:

| Section | Purpose |
|-----------|------|
| `RunIntakeAuthentication` | bearer token for webhook intake |
| `ConnectionStrings` | run store connection string |
| `RunPersistence` | `Postgres` or `InMemory` persistence mode |
| `RequestNormalization` | defaults and allowed Confluence hosts |
| `Jira` | Jira API connection settings |
| `JiraRetrieval` | comment inclusion and retrieval caps |
| `Confluence` | Confluence API connection settings |
| `DocumentationRetrieval` | page and chunk limits, comment-link behavior |
| `Scm` | Azure DevOps API connection settings |
| `RepoAdapters` | per-repository deterministic adapter configuration |
| `RepositoryRetrieval` | changed-file, diff, and neighboring-test limits |
| `GenerationContext` | prompt bundle size caps |
| `ScenarioGeneration` | min/max scenario constraints |
| `Llm` | provider, model, token, and temperature settings |

### Example Run Request

The integration tests exercise a request shape like this:

```json
{
  "sourceSystem": "JiraAutomation",
  "triggerType": "Manual",
  "issue": {
    "issueKey": "QA-1234",
    "issueId": "10001",
    "projectKey": "QA",
    "issueType": "Story",
    "summary": "Add retry handling to payment callback",
    "description": "Full issue description\nhttps://yourcompany.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+Flow",
    "url": "https://yourcompany.atlassian.net/browse/QA-1234"
  },
  "triggerInputs": {
    "generationMode": "ExecutableTests",
    "workflowPass": "ScenarioDesign",
    "testScope": "Api",
    "repositoryAlias": "bank-otp-api",
    "documentationUrl": "https://yourcompany.atlassian.net/wiki/spaces/API/pages/67890/Callback+Contract",
    "coverageIntent": "Regression",
    "outputTarget": "Both"
  },
  "issueFields": {
    "repositoryAlias": "bank-otp-api",
    "documentationUrl": "https://yourcompany.atlassian.net/wiki/spaces/QA/pages/11111/Test+Strategy"
  },
  "requester": {
    "accountId": "abc-123",
    "displayName": "Manuel Marcatili",
    "email": "manuel@example.com"
  }
}
```

## Usage

### Prerequisites

- .NET 10 SDK installed locally.
- A reachable PostgreSQL instance if you want to run the default persistence mode.
- Jira, Confluence, and Azure DevOps credentials configured when exercising live provider integrations.
- A bearer token configured in `RunIntakeAuthentication:BearerToken`.
- Docker Desktop or a compatible Docker daemon if you want to validate the container build.

### Run Locally

```powershell
dotnet restore src/Manso.sln
dotnet build src/Manso.sln
dotnet test src/Manso.sln
dotnet run --project src/Manso.Api
```

Default local config lives in `src/Manso.Api/appsettings.json`.

### Example API Call

```powershell
$token = "local-dev-token"
$body = @'
{
  "sourceSystem": "JiraAutomation",
  "triggerType": "Manual",
  "issue": {
    "issueKey": "QA-1234",
    "issueId": "10001",
    "projectKey": "QA",
    "issueType": "Story",
    "summary": "Add retry handling to payment callback",
    "description": "Full issue description\nhttps://yourcompany.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+Flow",
    "url": "https://yourcompany.atlassian.net/browse/QA-1234"
  },
  "triggerInputs": {
    "generationMode": "TestCasesOnly",
    "workflowPass": "ScenarioDesign",
    "testScope": "Api",
    "repositoryAlias": "bank-otp-api",
    "documentationUrl": "https://yourcompany.atlassian.net/wiki/spaces/API/pages/67890/Callback+Contract",
    "coverageIntent": "Regression",
    "outputTarget": "JiraComment"
  },
  "issueFields": {
    "repositoryAlias": "bank-otp-api",
    "documentationUrl": "https://yourcompany.atlassian.net/wiki/spaces/QA/pages/11111/Test+Strategy"
  },
  "requester": {
    "accountId": "abc-123",
    "displayName": "Manuel Marcatili",
    "email": "manuel@example.com"
  }
}
'@

Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:5206/api/runs `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -Body $body
```

Then inspect the run:

```powershell
Invoke-RestMethod http://localhost:5206/api/runs/<run-id>
Invoke-RestMethod http://localhost:5206/api/runs/<run-id>/artifacts
```

### Docker Build

```powershell
docker build -f src/Manso.Api/Dockerfile -t testing-agent-gateway:manso-net10 .
docker run --rm -p 8080:8080 testing-agent-gateway:manso-net10
```

## Versioning Strategy

### Runtime And Solution Baseline

- The repository runtime baseline is `.NET 10`.
- The solution name and project naming use the `Manso.*` convention.
- Product and deployment naming remain `testing-agent-gateway`.

### Planning And Runtime Guidance

- `implementation-plan/` holds the implementation and architecture documents.
- `agent-runtime/` holds runtime guidance that shapes agent behavior while working in the repo.
- `AGENTS.md` is the root entry point that points contributors and coding agents to those folders.

### Practical Rules

- Keep retrieval deterministic and bounded.
- Do not widen Confluence scope beyond explicit links.
- Do not write directly to protected branches.
- Do not auto-merge generated changes.
- Keep provider integrations replaceable behind interfaces.

## Azure Key Vault Setup

The deployment expects these secrets in the target environment vault:

- `testing-agent-gateway-api-version`
- `testing-agent-gateway-api-run-store-connection-string`
- `testing-agent-gateway-api-bearer-token`
- `testing-agent-gateway-api-run-persistence-provider`
- `testing-agent-gateway-api-run-persistence-auto-initialize-schema`
- `testing-agent-gateway-api-webhook-shared-secret`
- `testing-agent-gateway-api-jira-base-url`
- `testing-agent-gateway-api-jira-cloud-id`
- `testing-agent-gateway-api-jira-user-email`
- `testing-agent-gateway-api-jira-api-token`
- `testing-agent-gateway-api-jira-retrieval-include-comments`
- `testing-agent-gateway-api-jira-retrieval-max-comments`
- `testing-agent-gateway-api-confluence-base-url`
- `testing-agent-gateway-api-confluence-user-email`
- `testing-agent-gateway-api-confluence-api-token`
- `testing-agent-gateway-api-confluence-allowed-host`
- `testing-agent-gateway-api-documentation-include-comment-links`
- `testing-agent-gateway-api-documentation-max-pages`
- `testing-agent-gateway-api-documentation-max-chunks-per-page`
- `testing-agent-gateway-api-documentation-require-documentation`
- `testing-agent-gateway-api-scm-provider`
- `testing-agent-gateway-api-scm-base-url`
- `testing-agent-gateway-api-scm-organization`
- `testing-agent-gateway-api-scm-read-token`
- `testing-agent-gateway-api-scm-write-token`
- `testing-agent-gateway-api-repository-retrieval-max-changed-files`
- `testing-agent-gateway-api-repository-retrieval-max-diff-lines-per-file`
- `testing-agent-gateway-api-repository-retrieval-max-neighboring-tests`
- `testing-agent-gateway-api-repository-retrieval-max-neighboring-test-lines`
- `testing-agent-gateway-api-generation-context-max-changed-file-excerpts`
- `testing-agent-gateway-api-generation-context-max-neighboring-tests`
- `testing-agent-gateway-api-generation-context-max-comments`
- `testing-agent-gateway-api-llm-provider`
- `testing-agent-gateway-api-llm-api-key`
- `testing-agent-gateway-api-llm-model`
- `testing-agent-gateway-api-llm-base-url`
- `testing-agent-gateway-api-llm-max-output-tokens`
- `testing-agent-gateway-api-llm-temperature`
- `testing-agent-gateway-api-scenario-generation-min-scenarios`
- `testing-agent-gateway-api-scenario-generation-max-scenarios`
