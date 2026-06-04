# Consumer Repository Setup

This page describes what a repository must add before it can use `manso-testing-agent` safely and repeatably. There are two common use cases:

- Repository-owned CI: the product or test repository owns `.manso` guidance, repository docs, Manso pipeline stages, and optional Confluence docs publishing.
- Central webhook CI: a shared pipeline repository owns Jira-triggered design, release notes, and linked-Xray implementation pipelines for one or more target repositories.

## Choose The Integration Shape

Use repository-owned CI when the product or test repository should run Manso from its own pipeline. This is the right fit for repository-owned Xray implementation after normal build/test stages and for publishing repository docs to Confluence.

Use central webhook CI when Jira webhooks should trigger shared Manso workflows. This is the right fit for shared design pipelines, release-note generation, and linked-Xray implementation against target repositories selected from webhook payloads or pipeline parameters.

Both shapes still require the target repository to own its test rules and verification commands. The central pipeline can install and run the agent, but it should not invent repository-specific testing conventions.

## Step 1: Add Repository Guidance

Create a `.manso` folder in the target repository:

```text
.manso/
  testgen.md
  repo-conventions.json
  on-demand-guidance.md
  runtime-secrets.json
  agent-package/
    .npmrc
    package.json
```

Required files:

| File | Purpose |
| --- | --- |
| `.manso/testgen.md` | Human-readable rules for how Manso should implement tests in this repository. |
| `.manso/repo-conventions.json` | Machine-readable repository metadata, test projects, verification commands, and guidance file paths. |

Optional files:

| File | Purpose |
| --- | --- |
| `.manso/on-demand-guidance.md` | Lightweight instruction page telling the implementation agent what files to read first. |
| `.manso/runtime-secrets.json` | Declares runtime environment variables and Key Vault secrets needed by repository tests. Central implementation pipelines can read the same manifest from `tests/.manso/runtime-secrets.json` when target repositories keep test assets under `tests/`. |
| `.manso/agent-package/.npmrc` | Authenticated Azure Artifacts npm registry file for local or pipeline package installation. |
| `.manso/agent-package/package.json` | Local wrapper package for `npx` or npm scripts that run Manso from the repository. |

Keep `.manso/testgen.md` strict. It should say where Xray tests belong, which test framework to use, which production areas are off limits, and which verification command must pass before a PR is created.

## Step 2: Add `repo-conventions.json`

Start with the smallest accurate contract for the repository:

```json
{
  "schemaVersion": "1.0.0",
  "repository": "your-repository-name",
  "language": "csharp",
  "solutionFile": "src/Your.Service.sln",
  "unitTestFramework": "xUnit",
  "unitAssertionLibrary": "FluentAssertions",
  "unitMockingLibrary": "NSubstitute",
  "functionalTestFramework": "NUnit",
  "unitTestProjects": [
    "src/Tests/Your.Service.Tests/Your.Service.Tests.csproj"
  ],
  "functionalTestProject": "src/Tests/Your.Service.FunctionalTests/Your.Service.FunctionalTests.csproj",
  "xrayTestImplementationLevel": "functional",
  "xrayTestProject": "src/Tests/Your.Service.FunctionalTests/Your.Service.FunctionalTests.csproj",
  "xrayImplementationVerificationCommand": "dotnet test src/Tests/Your.Service.FunctionalTests/Your.Service.FunctionalTests.csproj --list-tests",
  "defaultVerificationCommand": "dotnet test src/Your.Service.sln --filter \"FullyQualifiedName!~FunctionalTests\"",
  "requiredContextFiles": [
    "src/docs/testing/testing-decisions.md",
    "src/docs/testing/test-architecture.md",
    "src/docs/testing/test-patterns.md",
    "src/docs/testing/ai-test-generation.md",
    ".manso/testgen.md"
  ],
  "defaultGuidanceFiles": [
    "src/docs/testing/test-architecture.md",
    "src/docs/testing/ai-test-generation.md",
    ".manso/testgen.md",
    ".manso/repo-conventions.json"
  ],
  "validationCommands": [
    "dotnet test src/Your.Service.sln --filter \"FullyQualifiedName!~FunctionalTests\"",
    "dotnet build src/Tests/Your.Service.FunctionalTests/Your.Service.FunctionalTests.csproj --no-restore",
    "dotnet test src/Tests/Your.Service.FunctionalTests/Your.Service.FunctionalTests.csproj --no-build --list-tests"
  ],
  "ignoredGeneratedPaths": [
    "bin/",
    "obj/",
    "TestResults/",
    "artifacts/",
    "out/"
  ]
}
```

The important rule is that Manso Xray work must go to the repository-owned test level selected for that use case. For example, a service may require Xray scenarios to be implemented only as functional/API tests, while another repository may require UI, contract, or integration tests. Capture that ownership rule explicitly instead of letting the agent infer it.

## Step 3: Add Testing Docs

Add repository-owned docs that the agent can read on demand:

```text
src/docs/testing/
  ai-test-generation.md
  test-architecture.md
  test-patterns.md
  testing-decisions.md
```

Recommended content:

| Document | Should explain |
| --- | --- |
| `testing-decisions.md` | Non-negotiable test placement and architecture decisions. |
| `test-architecture.md` | Test projects, fixtures, containers, data setup, and shared helpers. |
| `test-patterns.md` | Concrete examples and naming/assertion conventions. |
| `ai-test-generation.md` | Specific guardrails for generated or agent-authored tests. |

The implementation agent reads repository guidance from conventional folders including `.manso`, `architecture`, `docs`, `tests/.manso`, `tests/architecture`, and `tests/docs`. Prefer small focused docs over large catch-all instructions.

## Step 4: Add Local Package Entry Points

For a repository that wants local Manso commands, add `.manso/agent-package/.npmrc`:

```ini
registry=https://pkgs.dev.azure.com/<organization>/_packaging/<manso-npm-feed>/npm/registry/
always-auth=true
```

Then add `.manso/agent-package/package.json`:

```json
{
  "name": "your-repository-manso-workflow",
  "private": true,
  "version": "0.0.0",
  "scripts": {
    "generate-xray-tests": "generate-xray-tests",
    "implement-xray-tests": "implement-xray-tests",
    "generate-release-notes": "generate-release-notes",
    "review-pull-request": "review-pull-request"
  },
  "devDependencies": {
    "manso-testing-agent": "2.5.1"
  },
  "engines": {
    "node": ">=20"
  }
}
```

Keep the package version aligned with the currently published `manso-testing-agent` version in the configured npm feed.

Local smoke commands:

```powershell
cd .manso/agent-package
npm install
npx generate-xray-tests --issue ABC-123 --out ../../out --dry-run
npx implement-xray-tests --issue ABC-123 --repo ../.. --out ../../out --TestDesignEnabled true --prompt-only
```

## Step 5: Wire Repository-Owned CI

For repository-owned CI, add the shared template repository or equivalent local template source:

```yaml
resources:
  repositories:
    - repository: pipeline-templates
      type: git
      name: <azure-devops-project>/<pipeline-template-repository>
      ref: refs/tags/<template-version>
```

Then add the Manso implementation stage after tests:

```yaml
- template: templates/manso-xray-implementation-stage.yaml@pipeline-templates
  parameters:
    stageName: Manso_Xray_Implementation
    stageDisplayName: Manso Xray Test Implementation
    condition: and(eq(variables['isMainBranch'], 'true'), ne(variables['isPullRequest'], true))
    poolName: <agent-pool>
    templateRepo: pipeline-templates
    azureSubscription: <azure-service-connection>
    keyVaultName: <key-vault-name>
    repositoryName: your-repository-name
    targetBranch: main
    testDesignEnabled: true
```

Use `testDesignEnabled: true` when the repository pipeline should generate the Xray design first and then implement it. Use `testDesignEnabled: false` when implementation must use existing linked Xray tests only.

The shared template expects:

- `.manso/agent-package/.npmrc` in the repository.
- Read access to the npm feed that contains `manso-testing-agent`.
- Key Vault access for the configured `keyVaultName`.
- `System.AccessToken` access for scripts.
- Build service permission to create branches and PRs in the repository.

## Step 6: Publish Repository Docs To Confluence

For a repository with docs, add a docs root such as:

```text
src/docs/
  architecture/
  testing/
```

Use this diagram pattern when a page needs Mermaid or SVG assets:

```markdown
![Rendered diagram](media/example.svg)

Source: [example.mmd](media/example.mmd)
```

Then add the shared publish stage:

```yaml
- template: templates/publish-confluence-docs-stage.yaml@pipeline-templates
  parameters:
    stageName: Publish_Docs
    stageDisplayName: Publish Docs to Confluence
    dependsOn: [ Api_Docker ]
    condition: succeeded('Api_Docker')
    docsPath: src/docs
    confluenceBaseUrl: $(confluenceBaseUrl)
    confluenceSpaceKey: $(confluenceSpaceKey)
    parentPageId: $(confluenceParentPageId)
    confluenceEmail: $(ConfluenceEmail)
    confluenceApiToken: $(ConfluenceApiToken)
```

Set repository variables for the Confluence base URL, space key, and parent page id. Store `ConfluenceEmail` and `ConfluenceApiToken` as secret variables or Key Vault-backed variables.

## Step 7: Wire Central Webhook Pipelines

Use central webhook CI when a shared pipeline should react to Jira webhooks.

Create Azure DevOps pipelines from the shared pipeline repository:

```text
.azure/manso-testing-agent-design-webhook.yml
.azure/manso-testing-agent-implementation-webhook.yml
.azure/manso-release-notes-webhook.yml
```

Create incoming webhook service connections:

```text
JiraMansoTestingAgentIncoming
JiraMansoTestingAgentImplementationIncoming
JiraMansoTestingAgentReleaseNotesIncoming
```

Grant the central pipelines:

- Read access to the npm feed that contains `manso-testing-agent`.
- Access to the Key Vault that stores Manso secrets through the configured service connection.
- `System.AccessToken` access for scripts.
- Read/write repository access for implementation target repositories.
- Permission to clone and push to the configured Manso memory repository when memory is enabled.

The central design pipeline runs:

```text
generate-xray-tests --issue <key> --out <output-directory>
```

The central implementation pipeline clones the selected target repository and runs:

```text
implement-xray-tests --issue <key> --repo <target-repo> --out <output-directory> --TestDesignEnabled false
```

`--TestDesignEnabled false` means the implementation uses existing Xray tests linked to the Jira ticket instead of creating a new generated test design.

## Step 8: Add Key Vault Secrets

The usual shared Manso secrets are:

```text
manso-testing-agent-username
manso-testing-agent-jira-url
manso-testing-agent-jira-token
manso-testing-agent-azure-devops-pat
manso-testing-agent-llm-provider
manso-testing-agent-llm-api-key
manso-testing-agent-llm-model
manso-testing-agent-xray-base-url
manso-testing-agent-client-id
manso-testing-agent-client-secret
manso-testing-agent-xray-test-link-type
manso-testing-agent-xray-test-link-direction
manso-testing-agent-enable-confluence
```

Add observability secrets when tracing is enabled:

```text
manso-testing-agent-otel-provider
manso-testing-agent-otel-enabled
manso-testing-agent-otel-project-name
manso-testing-agent-otel-endpoint
manso-testing-agent-otel-public-key
manso-testing-agent-otel-secret-key
manso-testing-agent-otel-batch
manso-testing-agent-openinference-hide-inputs
manso-testing-agent-openinference-hide-outputs
manso-testing-agent-otel-codex-forward
```

The Azure DevOps PAT needs read access for PR context. If Manso creates implementation PRs, it also needs PR creation access in the target repository.

## Step 9: Validate Before Live Writes

Run local read-only or prompt-only checks first:

```powershell
npx generate-xray-tests --issue ABC-123 --out ./out --dry-run
npx implement-xray-tests --issue ABC-123 --repo . --out ./out --TestDesignEnabled true --prompt-only
npx review-pull-request --out ./out --no-comment
```

Then run one CI dry run or prompt-only run before enabling live Xray upload, branch push, PR creation, or Jira release-note upload.

## Consumer Checklist

Before considering a repository ready:

- `.manso/testgen.md` exists and states the test scope clearly.
- `.manso/repo-conventions.json` names the correct test projects and verification command.
- Testing docs exist and are referenced from `requiredContextFiles` or `defaultGuidanceFiles`.
- The npm feed authentication file exists where the selected pipeline expects it.
- Key Vault contains the Manso secrets used by the pipeline.
- The pipeline identity can read the feed, read Key Vault, clone memory, and write implementation branches.
- A dry-run design command succeeds.
- A prompt-only implementation command produces the expected prompt and does not edit the repo.
- The first live implementation run creates a branch and PR, not a direct commit to `main`.
