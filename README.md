# Manso Testing Agent

TypeScript/Node CLI workflow for turning one Jira ticket into downstream context, review, and Xray test-generation packs. The implementation is intentionally a bounded workflow: collect fixed data, validate JSON with Zod, render Markdown from the same validated JSON, and optionally apply Xray/Jira mutations.

The project uses first-party Atlassian REST/GraphQL, Azure DevOps REST for PR diffs, Xray Cloud GraphQL, and OpenAI for bounded summaries/plans. It does not use Rovo or a Jira MCP server.

## Quick Start

Install dependencies:

```powershell
npm install
```

Set local secrets in `.env` or provide the same variables through CI/Kubernetes secrets. Then run the whole workflow:

```powershell
.\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -DryRunGeneration
```

Or from Bash:

```bash
./scripts/run-ticket-workflow.sh --issue ABC-123 --out ./out --dry-run-generation
```

Remove `-DryRunGeneration` when you want the final step to create/update Xray tests, link them to the ticket, and create the Test Set.

If your shell blocks local scripts, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -DryRunGeneration
```

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
npx extract-ticket --issue ABC-123 --out ./out
npx summarize-pr-changes --issue ABC-123 --out ./out
npx summarize-confluence-impact --issue ABC-123 --out ./out
npx review-xray-tests --issue ABC-123 --out ./out
npx generate-xray-tests --issue ABC-123 --out ./out --dry-run
npx implement-xray-tests --issue ABC-123 --out ./out --prompt-only
```

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

## Workflow Steps

Run steps individually when you want more control:

```powershell
npm run extract-ticket -- --issue ABC-123 --out ./out
npm run summarize-pr-changes -- --issue ABC-123 --out ./out
npm run summarize-confluence-impact -- --issue ABC-123 --out ./out
npm run review-xray-tests -- --issue ABC-123 --out ./out
npm run generate-xray-tests -- --issue ABC-123 --out ./out --dry-run
npm run implement-xray-tests -- --issue ABC-123 --out ./out --prompt-only
```

Outputs are written under `out/<issue-key>/`:

| Step | Reads | Writes |
| --- | --- | --- |
| `extract-ticket` | Jira issue key | `context.json`, `context.md` |
| `summarize-pr-changes` | `context.json` | `pr-changes.json`, `pr-changes.md` |
| `summarize-confluence-impact` | `context.json` | `confluence-impact.json`, `confluence-impact.md` |
| `review-xray-tests` | `context.json` | `xray-test-review.json`, `xray-test-review.md` |
| `generate-xray-tests` | `context.json` plus optional packs | `xray-test-generation.json`, `xray-test-generation.md` and, unless `--dry-run`, Jira/Xray writes |
| `implement-xray-tests` | `xray-test-generation.json` plus repo guidance files | `xray-test-implementation-prompt.md`, `xray-test-implementation.json`, `xray-test-implementation.md`, plus a test implementation branch/commit/PR unless `--prompt-only` |

`generate-xray-tests` automatically looks for `xray-test-review.json`, `pr-changes.json`, and `confluence-impact.json` next to `context.json`. You can override those paths with `--xray-test-review`, `--pr-changes`, and `--confluence-impact`.

`implement-xray-tests` is designed to be invoked from the repository that should receive automated tests. The package stays repo-agnostic by reading repository-owned guidance files and passing them to your chosen code-agent command:

```powershell
npx implement-xray-tests --issue ABC-123 --out ./out --agent-command "<command that reads the prompt from stdin>" --verify-command "npm test"
```

By default it requires these files relative to the target repo root:

- `architecture/test-architecture.md`
- `docs/testing/ai-test-generation.md`
- `.manso/testgen.md`
- `.manso/repo-conventions.json`

The implementation command receives the prompt on stdin and these environment variables: `MANSO_TEST_IMPLEMENTATION_PROMPT`, `MANSO_TEST_ISSUE`, `MANSO_TEST_BRANCH`, and `MANSO_TEST_TARGET_BRANCH`. For a real implementation run, the CLI fetches the target/base branch from `origin`, creates a separate implementation branch from that base, commits the new test changes, pushes only the implementation branch, and creates an Azure DevOps PR. It never commits or pushes directly to the target/base branch. Use `--prompt-only` to only produce the prompt without any git mutations.

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

Set `CONFLUENCE_ENABLED=false` when `extract-ticket` should keep linked Confluence URLs from Jira but skip Confluence REST page-body hydration. `summarize-confluence-impact` logs that Confluence is disabled, writes no output, and exits successfully.

### OpenAI, PR Diffs, And Implementation PRs

```env
AZURE_DEVOPS_PAT=your_azure_devops_pat
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5.5
```

`AZURE_DEVOPS_PAT` needs read access to Azure DevOps Code for PR diff summaries. If `implement-xray-tests` should create the pull request, the same token also needs permission to create PRs in the target Azure DevOps repository. The PR summarizer currently supports Azure DevOps PR URLs from `context.json -> development.pullRequests`; implementation PR creation currently targets Azure DevOps remotes.

The LLM-backed steps are:

- `summarize-pr-changes`: summarizes PR diffs for test-gap context.
- `summarize-confluence-impact`: maps linked Confluence content to ticket impact.
- `review-xray-tests`: reviews existing linked Xray tests and the acceptance criteria they appear to cover.
- `generate-xray-tests`: creates a strict Xray manual test plan from the context packs.
- `implement-xray-tests`: does not call OpenAI directly; it writes a repo-specific implementation prompt and invokes your configured code-agent command.

The OpenAI-backed adapters use a shared QA persona named Juana: rigorous, skeptical, evidence-led, and bounded to the retrieved Jira, Confluence, PR diff, and Xray context. The prompts require English output, explicit uncertainty, and traceability from proposed tests back to source evidence.

### Xray Cloud

```env
XRAY_BASE_URL=https://xray.cloud.getxray.app
XRAY_CLIENT_ID=your_xray_client_id
XRAY_CLIENT_SECRET=your_xray_client_secret
XRAY_TEST_LINK_TYPE=tests
XRAY_TEST_LINK_DIRECTION=test-to-ticket
```

Use the Xray Cloud data residency base URL for your tenant when required, for example `https://eu.xray.cloud.getxray.app`.

`review-xray-tests` uses Xray Cloud credentials, when present, to fetch expanded existing test definitions and manual steps before calling the LLM. `generate-xray-tests` uses Xray Cloud GraphQL to create tests, replace manual steps on updated tests, and create the generated Test Set.

Before linking tests to the source ticket, the workflow calls Jira REST `GET /rest/api/3/issueLinkType`, resolves the `tests` / `is tested by` link type, and sends the Jira link payload by link type id. `XRAY_TEST_LINK_TYPE` defaults to `tests` and is only a lookup hint for Jira sites that use a different link type name. `XRAY_TEST_LINK_DIRECTION` defaults to `test-to-ticket`, which creates the Jira issue link with the Test as the outward issue and the ticket as the inward issue. If your Jira link type is configured in the opposite direction, set `XRAY_TEST_LINK_DIRECTION=ticket-to-test`.

## Workflow Runner

The runner executes the workflow in order:

```powershell
.\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -DryRunGeneration
```

```bash
./scripts/run-ticket-workflow.sh --issue ABC-123 --out ./out --dry-run-generation
```

Useful switches:

```powershell
.\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -SkipPrChanges -SkipConfluenceImpact -DryRunGeneration
.\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -ContinueOnOptionalFailure -DryRunGeneration
.\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -SkipXrayGeneration
.\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -ImplementXrayTests -TestImplementationCommand "<command that reads the prompt from stdin>" -TestVerificationCommand "npm test"
```

```bash
./scripts/run-ticket-workflow.sh --issue ABC-123 --out ./out --skip-pr-changes --skip-confluence-impact --dry-run-generation
./scripts/run-ticket-workflow.sh --issue ABC-123 --out ./out --continue-on-optional-failure --dry-run-generation
./scripts/run-ticket-workflow.sh --issue ABC-123 --out ./out --skip-xray-generation
./scripts/run-ticket-workflow.sh --issue ABC-123 --out ./out --implement-xray-tests --test-implementation-command "<command that reads the prompt from stdin>" --test-verification-command "npm test"
```

`extract-ticket` is always treated as required. PR changes, Confluence impact, and Xray review are enrichment steps; pass `-ContinueOnOptionalFailure` when you want the runner to continue if one of those optional steps is not configured. Xray generation is skipped only when `-SkipXrayGeneration` is passed. Test implementation is opt-in with `-ImplementXrayTests`, because a real implementation run mutates the target repo and must end by opening a PR. Use `-ImplementationPromptOnly` to generate the prompt without git mutations.

Every CLI prints progress logs to stderr with a command prefix and elapsed seconds. The workflow runners also log each npm command, step duration, and total workflow duration.

## Safety Notes

- `extract-ticket`, `summarize-pr-changes`, `summarize-confluence-impact`, and `review-xray-tests` are read-only against Jira, Confluence, Azure DevOps, and Xray.
- `generate-xray-tests` is mutating unless `--dry-run` is passed.
- `implement-xray-tests` mutates the local git repository by creating an implementation branch from the target/base branch, pushing that implementation branch, and creating an Azure DevOps PR. It refuses to start with a dirty worktree unless `--allow-dirty` is passed, and it refuses to use the target/base branch as the implementation branch.
- All output arrays are present even when empty.
- Partial optional data is recorded in `warnings`; hard failures such as missing ticket, auth failure, or invalid schema return non-zero.
- Do not commit real token values. `.env` and `extractor.config.local.json` are ignored by Git.

## Source Layout

- `src/*Cli.ts`: command entry points.
- `src/domain`: validated workflow contracts and domain transformations.
- `src/workflows`: orchestration for each workflow step.
- `src/integrations`: REST, GraphQL, and LLM adapters.
- `src/output/<workflow>`: JSON/Markdown rendering and file writing per workflow.
- `src/config`: runtime config and defaults.
- `src/shared`: generic helpers with no product-specific dependencies.

## Codeberg CI Publishing

The repository includes Codeberg CI / Woodpecker workflows for validation, version tagging, and public npm publishing.

Publishing is intentionally separated from validation:

- `.woodpecker/tests.yaml` validates pull requests and `main` with install, typecheck, tests, build, and package dry-run.
- `.woodpecker/version-tag.yaml` validates `main`, creates the next semantic version tag, and pushes it.
- `.woodpecker/publish.yaml` publishes only from tags matching `v*`.

The Woodpecker publish workflow targets the public npm registry at `https://registry.npmjs.org/` and creates `.npmrc` at runtime from secrets. Configure these repository or organization secrets in Codeberg CI:

- `codeberg_username`: Codeberg user allowed to push release tags.
- `codeberg_token`: Codeberg access token for that user with repository write permission.
- `npm_token`: npm access token with publish permission for `manso-testing-agent`. Use a token that can publish from CI, for example a granular token with 2FA bypass when your npm account requires 2FA.

## Automated Version Tags

The repository includes `.woodpecker/version-tag.yaml` for main-branch semantic version tagging. It is designed for this flow:

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
- `codeberg_username` and `codeberg_token` must be available to the `push` event so `.woodpecker/version-tag.yaml` can push the generated tag.

Manual release fallback:

```powershell
git tag -a v0.1.2 -m "Release v0.1.2"
git push origin v0.1.2
```

For a local authenticated publish, make sure `package.json` has the version you intend to publish, then use:

```powershell
npm run publish:npm
```
