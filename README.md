# Manso Testing Agent

TypeScript/Node CLI workflow for turning one Jira ticket into downstream context, release notes, review, and Xray test-generation packs. The implementation is intentionally a bounded workflow: collect fixed data, validate JSON with Zod, render Markdown from the same validated JSON, and optionally apply Xray/Jira mutations.

The project uses first-party Atlassian REST/GraphQL, Azure DevOps REST for PR diffs, Xray Cloud GraphQL, and direct LLM provider integrations for bounded summaries/plans. It does not use Rovo or a Jira MCP server.

## Documentation

Confluence-ready documentation lives under `docs/`. The validation pipeline publishes that folder with the local `publish-confluence-docs` script after `main` validation when the Confluence parent page variable is configured.

## Quick Start

Install dependencies:

```powershell
npm install
```

Set local secrets in `.env` or provide the same variables through CI/Kubernetes secrets. Then generate Xray tests for a ticket:

```powershell
npm run generate-xray-tests -- --issue ABC-123 --out ./out --dry-run
```

Remove `--dry-run` when you want the command to create/update Xray tests, link them to the ticket, and create the generated Test Set.

To implement automated tests from the generated design, run:

```powershell
npm run implement-xray-tests -- --issue ABC-123 --out ./out --TestDesignEnabled true --prompt-only
```

Remove `--prompt-only` when you want the implementation command to edit the target repo, verify, commit, push, and create a pull request.

## Use As An Npm Package

The package exposes both installable CLI binaries and a TypeScript library API.

Install from a local checkout while developing:

```powershell
npm install ..\manso-testing-agent
```

After publishing to your npm registry, install by package name:

```powershell
npm install manso-testing-agent
```

Run the CLIs from another project:

```powershell
npx generate-release-notes --issue ITSM-1234 --out ./out
npx generate-xray-tests --issue ABC-123 --out ./out
npx implement-xray-tests --issue ABC-123 --out ./out --TestDesignEnabled true
npx review-pull-request --out ./out
```

`manso-testing-agent` runs implementation and healing through SDK runners by default: `LLM_PROVIDER=openai` uses `@openai/codex-sdk`, and `LLM_PROVIDER=anthropic` uses `@anthropic-ai/claude-agent-sdk`. Downstream projects do not need to pass `--agent-command` for the normal Codex or Claude flow. Use `--agent-command` only when you explicitly want a custom shell command.

Import the workflow APIs when you want to compose the steps yourself:

```ts
import {
  AtlassianRestClient,
  AtlassianRestSource,
  extractTicketContext,
  loadRuntimeConfig,
  writeContextPack,
} from "manso-testing-agent";

const config = await loadRuntimeConfig();
if (!config.jiraRest) {
  throw new Error("Jira REST config is required.");
}

const client = new AtlassianRestClient({
  jira: {
    baseUrl: config.jiraRest.jiraUrl,
    username: config.jiraRest.jiraUsername,
    apiToken: config.jiraRest.jiraApiToken,
  },
});

const source = new AtlassianRestSource({
  client,
  ...(config.jiraRest.jiraCloudId ? { jiraCloudId: config.jiraRest.jiraCloudId } : {}),
});

try {
  const context = await extractTicketContext("ABC-123", source);
  await writeContextPack(context, "./out");
} finally {
  await source.close();
}
```

Before publishing or consuming the package tarball, verify the packaged contents:

```powershell
npm run pack:dry-run
```

## Automated Version Tags

The repository includes `.azure/azure-pipelines-version-tag.yml` for main-branch semantic version tagging. It is designed for this flow:

1. Create the first stable tag manually, for example `v0.1.1`.
2. Merge a PR into `main`.
3. The version-tag pipeline validates the package, finds the latest `vX.Y.Z` tag, calculates the next version, and pushes a new annotated tag.
4. The publish pipeline runs from the tag and stamps the npm package version from that tag before publishing. This is done in the pipeline workspace only; it does not push package version commits back to `main`.

By default it bumps the patch version:

- `v0.1.1` -> `v0.1.2`
- `v0.1.2` -> `v0.1.3`

Control the bump from the PR title or merge commit message:

- `#major`, `[major]`, or `semver:major`
- `#minor`, `[minor]`, or `semver:minor`
- `#patch`, `[patch]`, or `semver:patch`

If no marker is present, it uses `patch`.

Requirements:

- `main` should be protected so changes land through PRs.
- The repository build service must be allowed to create and push tags.
- The pipeline checkout keeps credentials with `persistCredentials: true`.

Manual release fallback:

```powershell
git tag -a v0.1.3 -m "Release v0.1.3"
git push origin v0.1.3
```

For a local authenticated publish, make sure `package.json` has the version you intend to publish, then use:

```powershell
npm run publish:azure
```

## Public Workflows

The package intentionally exposes four workflow commands. Lower-level extractors and adapters remain internal TypeScript building blocks, but they are not published as CLI entrypoints.

Issue-based outputs are written under `out/<issue-key>/`; pull request review outputs are written under `out/pr-<pull-request-id>/`.

### Durable Memory Cabin

Set `MANSO_MEMORY_ROOT` to the `manso-memory-cabin` Git repository URL when generated artifacts should persist beyond the local `out` directory and be available from any target repository:

```env
MANSO_MEMORY_ROOT=https://your-git-host/your-org/manso-memory-cabin.git
MANSO_MEMORY_ENABLED=true
```

When `MANSO_MEMORY_ROOT` is a Git URL, the agent clones it into `~/.manso/memory-cabins/<repo>-<hash>` on first use and reuses that clone later. Set `MANSO_MEMORY_CACHE_DIR` to choose a different clone cache and `MANSO_MEMORY_BRANCH` to force a branch. Local filesystem paths still work for development. Existing clean clones are refreshed with `git fetch` and `git pull --ff-only`; dirty clones are left as-is so local memory writes are not overwritten.

When enabled, every generated JSON/Markdown workflow output is mirrored into `artifacts/<scope>/<id>/latest/` plus a timestamped `artifacts/<scope>/<id>/runs/<timestamp>-<workflow>/` snapshot in the local memory clone. If the memory root is a Git repository, each mirrored artifact set is committed and pushed back to the memory remote. If direct push to the configured memory branch is rejected, the agent pushes a `manso-memory/<scope>/<id>` branch and opens or updates an Azure DevOps pull request back to the memory branch. Implementation and healing prompts are retained there too. The same memory root can also own Juana's editable persona at `persona/juana-manso.md`; when that file exists, LLM-backed workflows use it instead of the packaged fallback persona.

Memory writes are non-blocking by default: a failed mirror logs a warning and the workflow continues. Set `MANSO_MEMORY_STRICT=true` when missing memory retention should fail the run.

| Command | Main use | Writes | Mutates external systems |
| --- | --- | --- | --- |
| `generate-xray-tests` | Extract all ticket context, summarize PR/Confluence/Xray evidence when present, design manual Xray tests, and upload them to Jira/Xray | `context.json/md`, optional enrichment packs, `xray-test-generation.json/md` | Yes, unless `--dry-run` |
| `implement-xray-tests` | Build or reuse an Xray test implementation pack, generate an implementation prompt, run the code agent, verify/heal, commit, push, and create/reuse an Azure DevOps PR | `xray-test-implementation-prompt.md`, optional healing prompts, `xray-test-implementation.json/md` | Yes, unless `--prompt-only` or `--dry-run` |
| `generate-release-notes` | Extract a release Jira issue and linked ticket context, generate release notes, and optionally update the release ticket field | `release-notes.json/md` | Yes, unless `--no-upload` |
| `review-pull-request` | Review an Azure DevOps pull request against the detected Jira ticket and post a PR review comment | `code-review.json/md` | Yes, unless `--no-comment` |

### Generate Xray Tests

```powershell
npm run generate-xray-tests -- --issue ABC-123 --out ./out
```

This is the full test-design workflow. It first extracts the Jira ticket, comments, linked Confluence pages, linked Xray test metadata, linked PR references, expanded Xray definitions when existing tests are linked, Xray coverage review, and PR diff summaries. It then asks the configured LLM provider to design the Xray test plan and writes `xray-test-generation.json` plus `xray-test-generation.md`.

By default it creates or updates Xray tests, links them to the Jira ticket, and creates the generated Test Set. Use `--dry-run` for local-only design output:

```powershell
npm run generate-xray-tests -- --issue ABC-123 --out ./out --dry-run
```

You can pass `--context ./out/ABC-123/context.json` to reuse an existing context file. The command still runs available enrichment steps from that context before generating the new design. Advanced overrides `--xray-test-review`, `--pr-changes`, and `--confluence-impact` can point to specific enrichment packs.

### Implement Xray Tests

```powershell
npm run implement-xray-tests -- --issue ABC-123 --out ./out --TestDesignEnabled true
```

When `--TestDesignEnabled true`, implementation first runs the same workflow as `generate-xray-tests`, then uses the resulting `xray-test-generation.json` as the scope for automated test implementation.

```powershell
npm run implement-xray-tests -- --issue ABC-123 --out ./out --TestDesignEnabled false
```

When `--TestDesignEnabled false`, implementation does not create a new AI-designed Xray test plan. It extracts the existing Xray test cases linked to the Jira ticket, converts them into the implementation pack, and implements those existing tests.

You can bypass both modes and implement an existing pack directly:

```powershell
npm run implement-xray-tests -- --xray-test-generation ./out/ABC-123/xray-test-generation.json --repo C:\path\to\repo
```

Use `--prompt-only` to write the implementation prompt and output pack without editing git. Use `--dry-run` as a stronger local-only mode: it implies prompt-only and, when test design is enabled, it also makes the generated Xray design local-only instead of uploading to Xray.

`generate-release-notes` starts from a Jira release ticket such as `ITSM-1234`, extracts the release ticket, extracts each linked Jira ticket, includes linked-ticket descriptions, Confluence pages, branches, and pull request metadata, then asks the configured LLM provider to produce polished release notes. By default it writes the rendered notes back to the release ticket field `customfield_11101`:

```powershell
npx generate-release-notes --issue ITSM-1234 --out ./out
```

Use `--max-linked <number>` when a release ticket has too many linked issues for one release-note pass.

Use `--no-upload` when you only want local `release-notes.json` and `release-notes.md` files. Use `--release-notes-field <field>` to target a different Jira custom field. The uploader tries plain text first and automatically falls back to Atlassian Document Format for rich-text fields; pass `--field-format text` or `--field-format adf` to force one format.

The Markdown output is intended for release stakeholders and avoids repeated linked-ticket references, branch names, pull requests, repositories, Confluence page names, source coverage, and LLM provenance. The JSON output keeps the raw linked-ticket context for traceability.

`review-pull-request` is designed for Azure DevOps pull request validation pipelines. It resolves the current pull request from Azure DevOps pipeline variables, detects the first Jira key in the source branch, PR title, or PR description, fetches Jira and Confluence context for that ticket, reviews the PR diff with the configured LLM provider, writes `code-review.json` and `code-review.md`, and posts one top-level PR thread with technical and business review comments:

```powershell
npx review-pull-request --out ./out
```

Pass `--ticket ABC-123` to override detection, `--no-comment` to write artifacts only, or `--organization`, `--project`, `--repository`, and `--pull-request-id` when running outside an Azure DevOps PR pipeline. In Azure DevOps, expose `$(System.AccessToken)` as `SYSTEM_ACCESSTOKEN` or provide `AZURE_DEVOPS_PAT`, and make sure the build service identity can read code and create pull request threads.

`implement-xray-tests` is designed to be invoked from the repository that should receive automated tests. The package stays repo-agnostic by reading repository-owned guidance files and passing them to the implementation agent selected by `LLM_PROVIDER`: `openai` uses the Codex SDK runner, and `anthropic` uses the Claude SDK runner. A fully custom shell command is still available through `--agent-command`:

```powershell
npx implement-xray-tests --issue ABC-123 --out ./out --verify-command "npm test"
```

When `--verify-command` fails, `implement-xray-tests` automatically runs a verification healing loop before committing. It passes the failed command output to the same agent runner up to four times by default. Use `--heal-attempts <number>` to change the retry count, `--heal-agent-command "<command>"` to use a different explicit shell repair command, or `--no-heal` to preserve fail-fast verification. PR creation remains gated on a passing verification command.

For `LLM_PROVIDER=openai`, the default runner calls `@openai/codex-sdk` `runStreamed()` and records usage from `turn.completed`. For `LLM_PROVIDER=anthropic`, the default runner calls `@anthropic-ai/claude-agent-sdk` `query()` and records usage and `total_cost_usd` from the result message. `--agent-path` / `MANSO_TEST_IMPLEMENTATION_AGENT_PATH` overrides the provider executable. `--agent-arguments` / `MANSO_TEST_IMPLEMENTATION_AGENT_ARGUMENTS` is only valid with an explicit shell `--agent-command`.

Pass `--reuse-branch-if-possible` when rerunning implementation for a ticket that may already have an implementation PR. The CLI first looks for an active Azure DevOps PR on the target branch, preferring the requested implementation branch, then an older suffixed implementation branch for the same ticket. If it finds one, it checks out that PR source branch from `origin`, fast-forwards it, runs implementation again, reuses the PR, and pushes only when new changes are committed. If no matching PR or branch exists, it falls back to creating the branch from the target/base branch.

By default it requires these files relative to the target repo root:

- `architecture/test-architecture.md`
- `docs/testing/ai-test-generation.md`
- `.manso/testgen.md`
- `.manso/repo-conventions.json`

SDK runners receive the prompt directly and explicit shell commands receive it on stdin. All runners receive these environment variables: `MANSO_TEST_IMPLEMENTATION_PROMPT`, `MANSO_TEST_ISSUE`, `MANSO_TEST_BRANCH`, and `MANSO_TEST_TARGET_BRANCH`. For a real implementation run, the CLI fetches the target/base branch from `origin`, creates a separate implementation branch from that base unless `--reuse-branch-if-possible` finds an active PR or existing branch to reuse, commits the new test changes, pushes only the implementation branch, and creates or reuses an Azure DevOps PR. It never commits or pushes directly to the target/base branch. Use `--prompt-only` to only produce the prompt without any git mutations.

## Configuration

Use environment variables for local, CI, and Kubernetes runs. `--config <path>` is still supported for non-secret overrides, but no config file is required by default.

### Jira And Confluence

```env
JIRA_URL=https://your-site.atlassian.net
JIRA_USERNAME=service-account@example.com
JIRA_API_TOKEN=your_api_token
JIRA_CLOUD_ID=
CONFLUENCE_ENABLED=true
CONFLUENCE_URL=https://your-site.atlassian.net/wiki
CONFLUENCE_USERNAME=service-account@example.com
CONFLUENCE_API_TOKEN=your_api_token
```

Jira issue details, comments, issue links, remote links, and Confluence page hydration use Atlassian REST APIs. Pull request and branch extraction uses Atlassian's first-party GraphQL gateway, `gateway/api/graphql`, with `developmentInformation(issueId: ARI)`. Set `JIRA_CLOUD_ID` when you know the cloud id; otherwise the extractor tries to discover it from `/_edge/tenant_info`.

Set `CONFLUENCE_ENABLED=false` when issue extraction should keep linked Confluence URLs from Jira but skip Confluence REST page-body hydration. Workflows that use Confluence context continue without hydrated page content and record the missing content in warnings.

### LLM Provider, PR Diffs, PR Reviews, And Implementation PRs

```env
AZURE_DEVOPS_PAT=your_azure_devops_pat
LLM_PROVIDER=openai
LLM_API_KEY=your_llm_api_key
LLM_MODEL=gpt-5.5
```

`LLM_PROVIDER` supports `openai` and `anthropic`. It also selects the default implementation agent for `implement-xray-tests`. Existing `OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_BASE_URL` variables still work for OpenAI. For Anthropic, set `LLM_PROVIDER=anthropic` and either generic `LLM_API_KEY` / `LLM_MODEL` values or provider-specific `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` values. The default Anthropic model is `claude-sonnet-4-6`, API version defaults to `2023-06-01`, and max output defaults to `16000`.

`AZURE_DEVOPS_PAT` needs read access to Azure DevOps Code for PR diff summaries. If `implement-xray-tests` should create the pull request, the same token also needs permission to create PRs in the target Azure DevOps repository. The PR summarizer currently supports Azure DevOps PR URLs from `context.json -> development.pullRequests`; implementation PR creation currently targets Azure DevOps remotes.

For `review-pull-request` inside an Azure DevOps PR pipeline, `SYSTEM_ACCESSTOKEN` can be used instead of `AZURE_DEVOPS_PAT` when the pipeline allows scripts to access the OAuth token.

The public LLM-backed workflows are:

- `generate-xray-tests`: extracts the issue context, summarizes available PR/Confluence/Xray evidence, creates a strict Xray manual test plan, and optionally uploads it.
- `implement-xray-tests`: creates or reuses an Xray test implementation pack, writes a repo-specific implementation prompt, and invokes the Codex SDK runner, Claude SDK runner, or your explicitly configured code-agent shell command.
- `generate-release-notes`: extracts a release ticket plus linked Jira ticket context and generates release notes.
- `review-pull-request`: reviews the active Azure DevOps PR against the detected Jira ticket and posts a PR thread.

Internally, the test-design and implementation workflows compose smaller adapters for PR-diff summaries, Confluence impact summaries, existing-Xray-test review, Xray test planning, and implementation prompting. Those adapters are library building blocks, not public CLI entrypoints.

The LLM-backed adapters use a shared QA persona named Juana: rigorous, skeptical, evidence-led, and bounded to the retrieved Jira, Confluence, PR diff, and Xray context. The prompts require English output, explicit uncertainty, and traceability from proposed tests back to source evidence. When `MANSO_MEMORY_ROOT` is configured and `persona/juana-manso.md` exists, that file is used as Juana's canonical persona; otherwise the package uses its built-in fallback.

### LLM Observability

OpenTelemetry tracing is opt-in and supports `phoenix` or `langfuse` through `OTEL_PROVIDER`. When enabled, each public workflow is wrapped in a parent span: `workflow.generate-xray-tests`, `workflow.implement-xray-tests`, `workflow.generate-release-notes`, or `workflow.review-pull-request`. Internal workflow stages such as `workflow.context-extractor`, `workflow.test-implementation`, and LLM-backed task wrappers such as `task.summarizePullRequest` or `task.planXrayTests` nest under those parents. OpenAI/Anthropic SDK calls are instrumented separately with OpenInference `llm.*` spans. Implementation agent spans also emit `llm.token_count.prompt`, `llm.token_count.completion`, cached input tokens, reasoning output tokens, model/provider, workflow issue, workflow phase, and Claude `llm.cost.total_usd` when available.

```env
OTEL_PROVIDER=phoenix
OTEL_ENABLED=true
OTEL_PROJECT_NAME=manso-testing-agent
OTEL_ENDPOINT=http://localhost:6006
OTEL_API_KEY=
OTEL_SESSION_ID=
OTEL_USER_ID=
OTEL_BATCH=true
```

For Phoenix Cloud, set `OTEL_ENDPOINT` to your Phoenix endpoint and set `OTEL_API_KEY`. For local development, start Phoenix locally and keep `OTEL_ENDPOINT=http://localhost:6006`.

For Langfuse, switch the same shared variables and set the Langfuse keys:

```env
OTEL_PROVIDER=langfuse
OTEL_ENABLED=true
OTEL_PROJECT_NAME=manso-testing-agent
OTEL_ENDPOINT=http://localhost:3000
OTEL_PUBLIC_KEY=pk-lf-...
OTEL_SECRET_KEY=sk-lf-...
OTEL_SESSION_ID=
OTEL_USER_ID=
OTEL_BATCH=true
```

For local Langfuse, run `docker compose --profile langfuse up -d langfuse-web langfuse-worker` and use `OTEL_ENDPOINT=http://localhost:3000`. The compose stack bootstraps a local project with `OTEL_PUBLIC_KEY=pk-lf-local` and `OTEL_SECRET_KEY=sk-lf-local` unless you override those variables. `OTEL_ENDPOINT` can also be a Langfuse Cloud region host such as `https://cloud.langfuse.com` or `https://us.cloud.langfuse.com`, or a full OTLP endpoint ending in `/api/public/otel/v1/traces`.

Langfuse Sessions are driven through span attributes. Each traced workflow automatically adds both `session.id` and `langfuse.session.id` to the root span and all nested spans. Issue-based workflows default to `jira:<ISSUE>`, and PR reviews default to `ado-pr:<organization>/<project>/<repository>/<pull-request-id>` unless `--ticket` is provided. Set `OTEL_SESSION_ID` to force several commands into the same shared session.

Langfuse user consumption is attributed through `langfuse.user.id`. In Azure DevOps runs, the telemetry config first uses pipeline identity variables such as `BUILD_REQUESTEDFOREMAIL`. Outside Azure DevOps, set `OTEL_USER_ID` to a stable user or service account value.

OpenInference stores prompt and response content by default. Set `OPENINFERENCE_HIDE_INPUTS=true` and/or `OPENINFERENCE_HIDE_OUTPUTS=true` when traces should retain token and cost metadata without storing prompt or response text.

The workflow-level Codex span is enough for token and cost tracking. For full Codex internal traces, set `MANSO_CODEX_FORWARD_OTEL=true` to pass the selected backend endpoint through the Codex SDK config, or set `MANSO_CODEX_SDK_CONFIG` to a Codex SDK config JSON object for custom OTel settings.

### Xray Cloud

```env
XRAY_BASE_URL=https://xray.cloud.getxray.app
XRAY_CLIENT_ID=your_xray_client_id
XRAY_CLIENT_SECRET=your_xray_client_secret
XRAY_TEST_LINK_TYPE=tests
XRAY_TEST_LINK_DIRECTION=test-to-ticket
```

Use the Xray Cloud data residency base URL for your tenant when required, for example `https://eu.xray.cloud.getxray.app`.

`generate-xray-tests` uses Xray Cloud credentials to fetch expanded existing test definitions and manual steps when linked tests are present. It also uses Xray Cloud GraphQL to create tests, replace manual steps on updated tests, and create the generated Test Set. `implement-xray-tests --TestDesignEnabled false` uses the same issue extraction path to build an implementation pack from existing linked Xray tests without creating a new generated test design.

Before linking tests to the source ticket, the workflow calls Jira REST `GET /rest/api/3/issueLinkType`, resolves the `tests` / `is tested by` link type, and sends the Jira link payload by link type id. `XRAY_TEST_LINK_TYPE` defaults to `tests` and is only a lookup hint for Jira sites that use a different link type name. `XRAY_TEST_LINK_DIRECTION` defaults to `test-to-ticket`, which creates the Jira issue link with the Test as the outward issue and the ticket as the inward issue. If your Jira link type is configured in the opposite direction, set `XRAY_TEST_LINK_DIRECTION=ticket-to-test`.

## PowerShell Runner

The runner executes the workflow in order:

```powershell
.\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -DryRunGeneration
```

Useful switches:

```powershell
.\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -DryRunGeneration
.\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -ImplementXrayTests -ImplementationPromptOnly -DryRunGeneration
.\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -ImplementXrayTests -TestImplementationCommand "<command that reads the prompt from stdin>" -TestVerificationCommand "npm test"
```

The runner delegates to `generate-xray-tests` first, then optionally delegates to `implement-xray-tests`. Test implementation is opt-in with `-ImplementXrayTests`, because a real implementation run mutates the target repo and must end by opening a PR. Use `-ImplementationPromptOnly` to generate the prompt without git mutations, or `-DryRunGeneration` to keep Xray design/upload and implementation local-only. `-SkipXrayGeneration` is kept for compatibility and makes implementation use `--TestDesignEnabled false`, so it implements existing linked Xray tests from the ticket.

Every CLI prints progress logs to stderr with a command prefix and elapsed seconds. The PowerShell runner also logs each npm command, step duration, and total workflow duration.

## CI Or Kubernetes

Provide the same environment variables through your secret manager. Minimal Kubernetes Secret shape:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: manso-testing-agent
type: Opaque
stringData:
  JIRA_URL: https://your-site.atlassian.net
  JIRA_USERNAME: service-account@example.com
  JIRA_API_TOKEN: your_api_token
  JIRA_CLOUD_ID: your_cloud_id
  CONFLUENCE_ENABLED: "true"
  CONFLUENCE_URL: https://your-site.atlassian.net/wiki
  CONFLUENCE_USERNAME: service-account@example.com
  CONFLUENCE_API_TOKEN: your_api_token
  AZURE_DEVOPS_PAT: your_azure_devops_pat
  LLM_PROVIDER: openai
  LLM_API_KEY: your_llm_api_key
  LLM_MODEL: gpt-5.5
  OTEL_PROVIDER: phoenix
  OTEL_ENABLED: "false"
  OTEL_PROJECT_NAME: manso-testing-agent
  OTEL_ENDPOINT: http://localhost:6006
  OTEL_API_KEY: ""
  OTEL_PUBLIC_KEY: ""
  OTEL_SECRET_KEY: ""
  OTEL_SESSION_ID: ""
  OTEL_USER_ID: ""
  XRAY_BASE_URL: https://xray.cloud.getxray.app
  XRAY_CLIENT_ID: your_xray_client_id
  XRAY_CLIENT_SECRET: your_xray_client_secret
  XRAY_TEST_LINK_TYPE: tests
  XRAY_TEST_LINK_DIRECTION: test-to-ticket
```

Use that secret in the container env:

```yaml
envFrom:
  - secretRef:
      name: manso-testing-agent
```

## Safety Notes

- The issue extraction, PR summary, Confluence summary, and existing-Xray-test review stages are read-only against Jira, Confluence, Azure DevOps, and Xray.
- `review-pull-request` reads Jira, Confluence, and Azure DevOps, then posts a top-level Azure DevOps PR thread unless `--no-comment` is passed.
- `generate-release-notes` updates the Jira release ticket field `customfield_11101` by default. Pass `--no-upload` for local-only output.
- `generate-xray-tests` is mutating unless `--dry-run` is passed.
- `implement-xray-tests` mutates the local git repository by creating or optionally reusing an implementation branch, running the implementation agent, optionally running verification healing attempts, pushing the implementation branch when new changes are committed, and creating or reusing an Azure DevOps PR. It refuses to start with a dirty worktree unless `--allow-dirty` is passed, refuses to use the target/base branch as the implementation branch, and does not commit/push/PR when verification remains failing after healing.
- All output arrays are present even when empty.
- Partial optional data is recorded in `warnings`; hard failures such as missing ticket, auth failure, or invalid schema return non-zero.
- Do not commit real token values. `.env` and `extractor.config.local.json` are ignored by Git.

## Source Layout

- `src/*Cli.ts`: public command entrypoints plus internal CLI-compatible modules. `package.json` exposes only the four public workflow bins.
- `src/domain`: validated workflow contracts and domain transformations.
- `src/workflows`: orchestration for each workflow step.
- `src/integrations`: REST, GraphQL, and LLM adapters.
- `src/output/<workflow>`: JSON/Markdown rendering and file writing per workflow.
- `src/memory`: optional memory-cabin mirroring and persona loading.
- `src/config`: runtime config and defaults.
- `src/shared`: generic helpers with no product-specific dependencies.
