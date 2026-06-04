# Security And Permissions

## Secret Rules

- Never commit `.env`, real tokens, API keys, or local extractor configs.
- Use service accounts for CI where possible.
- Prefer least-privilege credentials for each workflow.
- Use non-mutating flags during investigation: `--dry-run`, `--prompt-only`, `--no-upload`, and `--no-comment`.
- Review generated artifacts before sharing them outside the project because they can include internal ticket, PR, and Confluence context.

## Required Permissions

| System | Required permissions |
| --- | --- |
| Jira | Read issues, comments, remote links, issue links, and issue link type metadata. Release-note upload also needs field update permission. |
| Confluence | Read linked pages for context. Docs publishing needs page create and update permissions under the configured parent page. |
| Xray Cloud | Read linked tests. Generation needs create or update tests, steps, Test Sets, and Jira links. |
| Azure DevOps | Read code and PR diffs. Implementation needs branch push and PR creation. PR review needs PR thread creation. |
| Azure Artifacts | Publish pipeline needs npm package publish permission. Consumers need package read permission. |
| Memory cabin | Read, clone, commit, push, and optionally create Azure DevOps PRs for memory branches. |
| LLM provider | Access to selected model and enough quota for the workflow. |
| Telemetry backend | Trace write permissions when OpenTelemetry is enabled. |

## Mutation Boundaries

Read-only or local-only when configured:

- `generate-xray-tests --dry-run`
- `implement-xray-tests --prompt-only`
- `implement-xray-tests --dry-run`
- `generate-release-notes --no-upload`
- `review-pull-request --no-comment`
- Confluence docs publishing with dry run enabled

External writes:

- Xray test creation or updates.
- Jira issue links and release notes field updates.
- Azure DevOps implementation branches, commits, pull requests, and review comments.
- Memory-cabin commits, pushes, and memory PRs.
- Confluence documentation pages.

## Confluence Page Safety

The docs publisher writes under a configured parent page and uses a title prefix to avoid collisions. If a page title exists outside the expected parent, the publisher either uses a fallback title or fails with guidance.

Set a stable title prefix before the first real publication.

