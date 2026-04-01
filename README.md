# Jira-Triggered AI Test Generation Agent

Deterministic ASP.NET Core/.NET 10 service for Jira-triggered test-design runs.

The current implementation accepts a Jira Automation-style webhook, normalizes the request, retrieves bounded context from Jira, explicit Confluence links, Azure DevOps, and optional Xray coverage, generates candidate scenarios through a replaceable LLM gateway, validates the result, and stores run artifacts for later inspection.

![Gateway flow](docs/flow.png)

## Current Status

Implemented end-to-end today:

- bearer-token protected `POST /api/runs` intake
- background run queue with persisted run state
- Jira issue retrieval with comments and linked-issue context
- explicit Confluence page retrieval only
- Azure DevOps repository, pull request, diff, and neighboring test retrieval
- Xray neighboring test lookup
- scenario generation through pluggable LLM gateways
- deterministic output validation
- artifact listing and artifact download endpoints
- optional Xray scenario auto-upsert for scenario-design test cases

Present in supporting services, but not wired through the current orchestration path:

- executable test code generation
- repository branch push and draft PR creation from generated code

Not implemented in the current runtime flow:

- Jira writeback stage
- MCP transport

## Runtime Flow

The background execution path is:

1. `RequestAccepted`: persist the run and enqueue background execution.
2. `RequestNormalized`: apply enum defaults, trim requester data, and keep only allowed explicit Confluence links.
3. `JiraContextCollected`: retrieve the Jira issue, selected comments, linked issues, and referenced issue context.
4. `ConfluenceResolved`: fetch only the explicit Confluence links provided on intake.
5. `RepositoryResolved`: resolve Azure DevOps repository and PR or branch context from Jira development metadata.
6. `CodeContextCollected`: collect changed files, bounded unified diffs, and neighboring tests.
7. `XrayContextCollected`: retrieve linked and neighboring Xray tests when enabled.
8. `ContextBundleBuilt`: build the structured prompt bundle and store preview artifacts.
9. `ScenariosGenerated`: call the configured LLM and validate the returned JSON contract.
10. `TestsGenerated`: auto-create or update Xray tests only when Xray auto-upsert is enabled and the run qualifies.
11. `OutputsValidated`: run deterministic validation over generated scenarios.
12. `OutputsWritten`: store markdown/json artifacts and a write summary.

`dryRun=true` stops after `ContextBundleBuilt`, stores prompt preview artifacts, and skips generation, validation, and write output.

## API

Authentication:

- `POST /api/runs` requires `Authorization: Bearer <token>` where the token comes from `RunIntakeAuthentication:BearerToken`.
- `GET` endpoints use the same HTTP pipeline and return the stored run state or artifact content.

Current endpoints:

| Route | Description |
| --- | --- |
| `POST /api/runs` | Accept a run request and return `202 Accepted` |
| `GET /api/runs/{runId}` | Return run status, stages, warnings, errors, repository, and PR references |
| `GET /api/runs/{runId}/artifacts` | List stored artifact metadata |
| `GET /api/runs/{runId}/artifacts/{artifactName}` | Return the full content of a stored artifact |
| `GET /health/live` | Liveness probe |
| `GET /health/ready` | Readiness probe |

## Request Contract

The current webhook payload is smaller than earlier planning docs. The API now accepts this shape:

```json
{
  "requestSource": "JiraAutomation",
  "triggerType": "Manual",
  "issue": {
    "key": "QA-1234",
    "id": "10001"
  },
  "triggerInputs": {
    "generationMode": "TestCasesOnly",
    "workflowPass": "ScenarioDesign",
    "extraDocumentationLinks": "https://yourcompany.atlassian.net/wiki/spaces/API/pages/67890/Callback+Contract",
    "coverageIntent": "Regression",
    "outputTarget": "JiraComment",
    "dryRun": false
  },
  "requestedBy": {
    "accountId": "abc-123",
    "displayName": "Manuel Marcatili",
    "email": "manuel@example.com"
  }
}
```

Notes:

- `issue` currently contains only `key` and `id`.
- `triggerInputs.extraDocumentationLinks` is a newline-delimited string of explicit Confluence URLs.
- only `https://.../wiki/...` links on allowed hosts survive normalization
- repository alias, test scope, and documentation URL fields are not part of the current intake contract
- test scope starts from the configured default and can be inferred from repository context at runtime

Supported enum values:

| Field | Values |
| --- | --- |
| `generationMode` | `TestCasesOnly`, `ExecutableTests` |
| `workflowPass` | `ScenarioDesign`, `AutomationImplementation` |
| `coverageIntent` | `HappyPathOnly`, `Regression`, `EdgeCases`, `HighRisk` |
| `outputTarget` | `JiraComment`, `DraftPullRequest`, `Both` |

Default normalization values come from `RequestNormalization` in `src/Manso.Api/appsettings.json`.

## Artifacts

The run store keeps artifact metadata and full artifact content. Common artifacts are:

| Artifact | When it appears |
| --- | --- |
| `generation-context-bundle.json` | dry runs and normal runs after context assembly |
| `llm-prompt.json` | dry runs and normal runs after context assembly |
| `generated-scenarios.json` | successful scenario generation |
| `generated-scenarios.md` | successful output writing |
| `validation-report.json` | successful validation |
| `write-result.json` | successful output writing |
| `xray-sync-result.json` | when Xray auto-upsert runs |

Important limitation:

- the current orchestration does not pass a generated code bundle into `OutputWriter`, so `write-result.json` usually reports artifact-only outcomes such as `ArtifactsStoredNoRepoWrite`
- draft PR creation support exists in the SCM/output services, but it is not exercised by the current API execution path

## Repository Resolution Rules

Repository context is intentionally deterministic:

- repository selection comes from Jira development information
- `ScenarioDesign` accepts open or merged pull requests and ignores rejected or abandoned ones
- `AutomationImplementation` only uses merged or completed pull requests
- if Jira does not uniquely identify one repository, the repository stages are skipped with explicit warnings instead of defaulting silently

## Xray Behavior

Two Xray features exist today:

- neighboring Xray test retrieval for prompt context
- optional automatic test case upsert from generated scenarios

Automatic Xray upsert only runs when all of these are true:

- `XrayRetrieval:EnableScenarioAutoUpsert=true`
- `generationMode=TestCasesOnly`
- `workflowPass=ScenarioDesign`
- validation outcome is `Pass` or `PassWithWarnings`

## LLM Providers

Supported `Llm:Provider` values:

- `Disabled`
- `Mock`
- `OpenAi`
- `Anthropic`

Provider behavior:

- `Mock` is the safest local default for deterministic development and tests
- `OpenAi` uses Chat Completions for standard models and Responses API for `-pro` and `codex-max` style models
- OpenAI `-pro` models run in background mode and are polled until completion
- `Anthropic` uses the Messages API

## Configuration

Primary configuration sections currently used by the application:

| Section | Purpose |
| --- | --- |
| `ConnectionStrings` | run-store connection string |
| `RunIntakeAuthentication` | bearer token for webhook intake |
| `RunPersistence` | `Postgres` or `InMemory` run storage |
| `RequestNormalization` | enum defaults and allowed Confluence hosts |
| `Jira` | Jira API connection settings |
| `JiraRetrieval` | Jira comment retrieval behavior |
| `Confluence` | Confluence API connection settings |
| `DocumentationRetrieval` | Confluence page and chunk limits |
| `Xray` | Xray API connection settings |
| `XrayRetrieval` | Xray lookup and auto-upsert controls |
| `Scm` | Azure DevOps connection settings |
| `RepositoryRetrieval` | changed-file, diff, and neighboring-test limits |
| `GenerationContext` | context bundle size caps |
| `ScenarioGeneration` | minimum and maximum scenario counts |
| `RuntimePrompt` | path to `agent-runtime/` markdown guidance |
| `Validation` | placeholder, path, extension, and assertion rules |
| `Llm` | provider, model, token, timeout, and temperature |

The local baseline config lives in `src/Manso.Api/appsettings.json`.

## Run Locally

Prerequisites:

- .NET 10 SDK
- PostgreSQL if you keep `RunPersistence:Provider=Postgres`
- Jira, Confluence, Azure DevOps, Xray, and LLM credentials only if you want live provider calls

Build and run:

```powershell
dotnet restore src/Manso.sln
dotnet build src/Manso.sln
dotnet test src/Manso.sln
dotnet run --project src/Manso.Api
```

The development profile listens on `http://localhost:5206`.

Example request:

```powershell
$token = "local-dev-token"
$body = @'
{
  "requestSource": "JiraAutomation",
  "triggerType": "Manual",
  "issue": {
    "key": "QA-1234",
    "id": "10001"
  },
  "triggerInputs": {
    "generationMode": "TestCasesOnly",
    "workflowPass": "ScenarioDesign",
    "extraDocumentationLinks": "https://yourcompany.atlassian.net/wiki/spaces/API/pages/67890/Callback+Contract",
    "coverageIntent": "Regression",
    "outputTarget": "JiraComment",
    "dryRun": false
  },
  "requestedBy": {
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

Inspect the run and artifacts:

```powershell
Invoke-RestMethod http://localhost:5206/api/runs/<run-id>
Invoke-RestMethod http://localhost:5206/api/runs/<run-id>/artifacts
Invoke-RestMethod http://localhost:5206/api/runs/<run-id>/artifacts/generated-scenarios.md
```

## Docker

```powershell
docker build -f src/Manso.Api/Dockerfile -t testing-agent-gateway:manso-net10 .
docker run --rm -p 8080:8080 testing-agent-gateway:manso-net10
```

## Repository Layout

```text
testing-agent-gateway/
|- agent-runtime/
|- docs/
|- implementation-plan/
|- infra/
`- src/
   |- Manso.Api/
   |- Manso.Application/
   |- Manso.Domain/
   |- Manso.Infrastructure/
   |- tests/
   |  |- Manso.UnitTests/
   |  `- Manso.IntegrationTests/
   `- Manso.sln
```

Planning and runtime guidance:

- `AGENTS.md` is the repo entry point for agent instructions
- `implementation-plan/00-agent-instructions.md` is the starting point for implementation guidance
- `implementation-plan/` contains the numbered architecture and workflow documents
- `agent-runtime/` contains markdown guidance used during prompt assembly

## Deployment Notes

- the Docker image is built from `src/Manso.Api/Dockerfile`
- Azure pipeline config lives in `.azure/pipeline-app.yaml`
- Key Vault secret declarations for the current deployment live in `infra/terraform/keyvault-rps-infra.tf`

## Guardrails

- retrieval is bounded and deterministic
- Confluence retrieval is explicit-link only
- protected branches must not be written directly
- auto-merge is not allowed
- generated output must pass deterministic validation before any future repository write path is allowed to proceed
