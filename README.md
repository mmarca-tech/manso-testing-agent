# Manso

An end-to-end AI testing agent: context-aware **test design** plus multi-stack
test **automation**. Manso turns a Jira ticket into a Gherkin (or
plain-English) test design uploaded to Xray as linked Cucumber tests, and a
verified automation pull request in the target repo — then learns from PR review
feedback and proposes guideline/skill updates (always via a human-reviewed PR).

📖 **[Feature reference](./docs/FEATURES.md)** · 🏗️ **[Architecture & diagrams](./docs/architecture.md)** · 🗺️ **[Roadmap](./docs/ROADMAP.md)** · 🧪 **[Testing guide (real Jira + Azure repo)](./TESTING.md)**

## What it does

- **Context layer** — fetches the Jira ticket, comments, links, attachments, and
  dev info; converts ADF to structure-preserving Markdown; expands epic/parent/
  subtasks; understands text + image attachments (vision); builds an evidence
  graph + BM25 knowledge index; an optional tool-using Researcher (`--deep`).
- **Test design** — extracts acceptance criteria, authors Gherkin with enforced
  tag conventions, enforces an AC-coverage gate, and reuses existing repo steps /
  de-duplicates against existing scenarios and linked Xray tests.
- **Xray** — creates Gherkin scenarios as Cucumber tests linked to the story
  (idempotent).
- **Implementation** — drives a code agent (Claude Agent SDK / Codex / Shell) to
  write step definitions, runs the stack's verify command, heals failures, then
  branches, commits, and raises a PR. Can use **MCP tools** (Playwright, Figma).
- **PR feedback loop** — `@manso` comments trigger scoped fixes + replies;
  `@update-knowledge` / `@update-agent` propose guideline/skill updates via a
  separate review PR. Loop-safety guards throughout.
- **Governance + eval** — secret/PII redaction, cost budgets, an audit log, and a
  `manso eval` release gate over golden test designs.
- **Observability** — OpenTelemetry → Phoenix or Langfuse (tokens, cost, latency,
  per-issue sessions).
- **Optional Memory Cabin** — redacted cross-repository artifact history and
  curated supplemental context, disabled by default. Existing local memory stays
  authoritative; see [configuration and safeguards](./docs/MEMORY-CABIN.md).

## CLI

| Command | Purpose |
|---|---|
| `manso init --repo <path>` | Scaffold the `.agents/` folder |
| `manso check --repo <path>` | Score repo readiness (CI-gateable) |
| `manso fetch --issue <KEY>` | Diagnostic: fetch one ticket |
| `manso skills --repo <path>` | List resolved skills |
| `manso design-tests --issue <KEY> [--deep] [--dry-run\|--yes]` | Context → design → Xray |
| `manso implement-tests --repo <path> (--design <pack.json> \| --issue <KEY>) [--pr]` | Implement → verify → heal → PR. `--issue` reconstructs the design from the story's linked Xray tests (stateless, for pipelines) |
| `manso respond-to-pr --repo <path> --pr <id> --issue <KEY>` | Act on PR comments |
| `manso review-pull-request --repo <path> --pr <id> [--issue <KEY>] [--no-comment\|--dry-run]` | Proactive technical + business review; writes reports, posts located findings inline and one overall summary |
| `manso generate-release-notes --issue <KEY> [--repo <path>] [--comment]` | Generate team-template (internal) and external release notes for a release ticket, or for a whole month (`--project <KEY> --issueType <ID> --date <MM/YY>`) |
| `manso eval --cases <dir>` | Score golden designs against the gate |

All commands support `--help`.

### Proactive pull-request review

`review-pull-request` ports Manso's proactive review workflow, independently of
the mention-driven `respond-to-pr` responder. It reads Azure DevOps or GitHub
PR metadata and base-to-head patches, detects a Jira key from the source branch,
title, or description (or uses `--issue`), and reuses the Researcher for Jira and
Confluence context. The target checkout needs a `.agents/manso.config.json`
(`manso init --repo <path>`); Markdown files in `.agents/guidelines/` supply
repository conventions. No checkout, edits, push, or platform approval occurs.

```powershell
npm run manso -- review-pull-request --repo C:\work\my-app --pr 123 --no-comment
```

Reports are written to `<out>/pr-123/code-review.json` and `code-review.md`.
The structured review contains summary, business impact, technical assessment,
approval recommendation, technical/business findings with severity and evidence,
and questions. Without `--no-comment` or `--dry-run`, findings with a validated
file/line are posted **inline on the PR diff**, followed by one top-level
advisory summary containing overall results, questions, warnings, and findings
without a precise line. The summary does not duplicate inline finding details;
the Markdown/JSON artifacts always retain the complete review.
New/added lines use the right side; removed lines use the left side.
Omitted `side` defaults to `right` for compatibility with existing reviews.
Lines must be present in the supplied patch text, not just within a hunk's
declared range. Azure threads bind to the reviewed iteration and tracked file;
GitHub review comments bind to the reviewed source commit.
Both flags suppress **all** inline and summary writes.
Dry-run still reads external services and calls the LLM.
Failed LLM/schema/usage checks produce a visible `needs-human-review` report
and exit 1, not a successful empty review. A fallback manual-review comment
may be posted; budget breaches and changed PR commits suppress commenting.
Missing/truncated evidence is always marked `needs-human-review`.
Commits are rechecked before each comment. If posting partially fails or the PR
changes mid-posting, the run fails explicitly and the audit log records comments
already posted; it does not silently move rejected inline findings to unrelated
lines or retry the whole posting batch.

The verb applies the existing built-in/custom redactor to prompts, nested
reports and comments, and persists audit events. Cost is estimated from the
shared model price table (`MANSO_MODEL_PRICES` extends it for deployment
names it does not know), recorded in the same cost ledger as the other verbs,
and checked against the target repo's `policy.budgets`:

```json
{
  "policy": {
    "budgets": { "maxCostPerRunUsd": 1, "maxCostPerDayUsd": 10 },
    "redactPatterns": []
  }
}
```

**Any configured cost limit requires a known model price**; unknown cost is never
treated as zero under a limit. A breach emits a `budget.breached` audit event.
Before the single review call, the verb checks the existing budget helper using
a conservative UTF-8 input-token bound plus the full 4,000-output-token cap.
Provider token usage (the client's accumulated usage) is accounted after the
response, including malformed output; missing usage charges the reservation
conservatively. Cached input uses the price table's cached rate, as in the other
verbs.
SDK retries are disabled for this governed call so hidden paid retries cannot
bypass the reservation. Accounting is conservative, not invoice reconciliation.

Use `MANSO_COST_LEDGER` and `MANSO_AUDIT_LOG` to put governance files on
persistent shared storage when enforcing a daily budget across pipeline runs.
Review runs sharing a ledger are serialized by a fail-fast lock. A crashed
process may leave `<ledger>.review.lock`; remove it only after confirming no
review is running. Other verbs retain their existing ledger behavior.
Audit/ledger persistence errors fail the review instead of bypassing governance.
Without pricing or cost limits, the report explicitly records USD cost as unknown.

See [the PR-validation pipeline example](./docs/PIPELINE.md#proactive-pr-validation).

### Release notes

`generate-release-notes` reads a release ticket and its linked tickets and
writes three files to `<out>/<ISSUE-KEY>/`:

- `release-notes.md`: internal notes following the team release-note template
  (Release Version, Release Date, Description, Contributors, then **New Features**,
  **Maintenance** and **Bug fixes** tables with *Description (Why)*, *Ticket Link*,
  *Product affected* and *Release Date*). Ends with a reviewer-only list of
  excluded tickets. This is also the format posted with `--comment`.
- `release-notes.external.md`: external-facing notes with no ticket keys, branches
  or PR details.
- `release-notes.json`: the full pack.

The LLM writes the prose and picks the section for each ticket. Ticket links,
*Product affected* (the Jira **Affected services** field, found by name, plus
components), fix version, release dates and contributors (assignees) come from
Jira. Linked tickets that are not in the `done` status category, or that were
resolved as Won't Do, Duplicate, Cancelled and similar, are excluded before any
PR analysis and listed with their reason. If a ticket doesn't say why a change
matters, the row is marked **Needs context** and nothing is invented.

**Monthly summary.** Pass a project, an issue type and a month instead of
`--issue` to cover every release completed in that month, for example the
`[System] Change` tickets in ITSM:

```powershell
npm run manso -- generate-release-notes --project ITSM --issueType 10903 --date 10/26
# narrow it with extra JQL; tune parallelism (1-8, default 4)
npm run manso -- generate-release-notes --project ITSM --issueType 10903 --date 10/26 --jql "\"Affected services\" = \"Manso Pay\"" --concurrency 6
```

- A release belongs to the month of its **Change completion date**, or of its
  resolution date when that field is empty. It must be in status `Completed`;
  use `--status` to change that.
- Every matching release is processed, with no cap. The run logs how many
  matched before it starts. Each release costs its own LLM call or calls, and
  `--concurrency` saves time, not tokens.
- Each release runs the single-release pipeline above with its own Jira
  provider. One extra LLM call writes the month-level summary.
- A release that fails is skipped with a warning and listed in `failedKeys`.
  If every release fails, the run fails.
- Output goes to `<out>/<PROJECT>-<YYYY-MM>/`, in the same three files.
  `release-notes.json` holds every release's pack and the JQL that was used.
  The internal markdown combines all releases into the three template tables;
  each row links its ticket *via* its change. The external markdown has a
  section per release with no keys or links.
- `--comment` isn't available in monthly mode.
- Progress: in a terminal, a live bar shows done/total, OK and failed counts,
  how many are running, elapsed time, ETA and the last change finished.
  Failures and fallback notes are printed above the bar. When stderr isn't a
  terminal (CI pipelines), it prints one plain line per change instead. The
  final summary lists failed changes, changes with fallback notes and the
  total time.

Jira REST calls retry on `429` for all methods, and on `503` for GET/PUT but
not POST, up to three times, honouring `Retry-After`.

## Versioned npm releases

Manso is released to GitHub Packages as
`@mmarca-tech/manso-testing-agent@X.Y.Z`. Immutable annotated `vX.Y.Z` tags
identify source revisions; the release workflow aligns the packaged CLI version
to the tag and publishes a changelog with the archive. GitHub Actions also
publishes versioned images to GHCR. See
[release setup](./docs/RELEASING.md).

The shared `rps-pipeline-templates` Manso-named template paths now support
Manso on their **next major template tag**. Consumers pin that template tag
and explicitly pass
`packageSpec: '@mmarca-tech/manso-testing-agent@X.Y.Z'` (an actual published
version).
Older template tags remain unchanged and continue to run Manso. Consumer
repository cutover to `.agents/` is a separate step.

The Jira-triggered Azure Pipelines runners remain in place because Jira rules
call the Azure Pipelines REST API. Their production container runner now pulls
from GHCR; CI and package/image publication use GitHub Actions.

## Running on a pipeline

Manso ships a **Docker image** (Playwright base) and **Azure Pipelines** so
the three Jira automation rules — generate / implement / handover — run
unattended. The implement step is **stateless** (`--issue` reconstructs the
design from the story's linked Xray tests), so each rule can run on its own.
Build the image locally with `npm run docker:build`; GitHub Actions publishes
it to GHCR. See **[docs/PIPELINE.md](./docs/PIPELINE.md)** for the GHCR and
Jira → Pipelines REST wiring.

## Status

The full plan (**M0–M14**) is delivered: 279 tests across 31 files, type-check
clean. Roadmap items: budget-enforcement wiring (M15), audit emission (M16),
GitHubAdapter (M17) — see [architecture.md](./docs/architecture.md#roadmap-next-milestones).

## Development

Requires Node.js ≥ 20.

```
npm install
npm run check     # type-check (tsc --noEmit)
npm test          # vitest (no network)
npm run build     # compile to dist/
```

Run the CLI without building:

```
npm run manso -- --help
# or
npx tsx src/cli/main.ts --help
```

## Configuration

- **Secrets** come from environment variables — see `.env.example`
  (`JIRA_*`, `XRAY_*`, `AZURE_DEVOPS_PAT`, LLM keys, `OTEL_*`,
  `MANSO_SANDBOX`, `MANSO_AGENT_REPO`, `MANSO_REPO_ROOTS`).
- **Per-repo conventions** live in a `.agents/` folder created by
  `manso init`: `manso.config.json`, `guidelines/`, `memory/`, and
  `skills/` (which override the packaged skills).
- **Optional cross-repo memory** requires explicit `MANSO_MEMORY_ENABLED=true`
  and a `MANSO_MEMORY_ROOT` outside the target repository. Failures warn by
  default; `MANSO_MEMORY_STRICT=true` makes them fatal. See
  [Memory Cabin](./docs/MEMORY-CABIN.md).

Secrets live only in `.env` (gitignored) — never commit them.
