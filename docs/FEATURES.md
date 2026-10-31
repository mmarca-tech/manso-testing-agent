# Manso — Feature Reference

Manso turns a Jira ticket into (1) a Gherkin/plain-English **test design**
uploaded to Xray as linked Cucumber/Manual tests, and (2) a **verified
automation PR** in the target repo — then keeps learning from PR review
feedback. It runs interactively from a CLI or **unattended from Jira automation
rules** via an Azure pipeline. This document describes every feature in detail,
grouped by capability area.

> **Status legend:** ✅ built & tested · 🔌 built, live-only verification ·
> 🗺️ roadmap (see the end).

> **Other docs:** [ROADMAP.md](./ROADMAP.md) · [CHANGELOG.md](./CHANGELOG.md)
> (recent changes) · [PIPELINE.md](./PIPELINE.md) (run from Azure Pipelines) ·
> [JIRA-AUTOMATION.md](./JIRA-AUTOMATION.md) (create the Jira rules) ·
> [architecture.md](./architecture.md) · [EVALUATION.md](./EVALUATION.md)
> (solution review: open issues & next investments).

---

## 1. CLI surface

One binary, `manso`, with a verb dispatcher (`src/cli/main.ts`). Every verb
is also a library function (`runX(input)`) so it is independently testable.

| Verb | What it does |
|---|---|
| `init` | Scaffold the `.agents/` folder into a target repo (config, conventions, guidelines, memory, skills override dir). |
| `check` | Score a repo's Manso readiness (0–100), validate `.agents/manso.config.json`, detect stacks, check creds. CI-gateable. |
| `fetch` | Diagnostic: fetch one Jira ticket through the Context Layer and print the normalized issue. |
| `skills` | List resolved skills for a repo/phase (packaged + repo overrides), with source tags. |
| `design-tests` | Researcher → Test Architect → Coverage Auditor → (optional) Xray sink. Produces a `TestDesignPack` + `.feature` files. Flags include `--deep`, `--test-fields`, `--reporter`, `--derive-requirements`/`--adversarial-critique`/`--risk-coverage` (M22), `--dry-run`/`--yes`. |
| `implement-tests` | Implementer → (M20 env + explore) → Verifier → Healer → commit → PR. Produces an `ImplementationPack`. Takes `--design <file>` **or** `--issue <KEY>` (Xray-sourced), plus `--require-linked-tests`, `--no-env`, `--max-heal-attempts`. |
| `analyse-coverage` | Assess a story's linked tests vs the requirement, post the gap analysis as a Jira comment, and create the missing tests in Xray (reusing existing step phrasings). Flags: `--comment`, `--create-tests`, `--test-fields`, `--reporter`. |
| `respond-to-pr` | Read PR comment threads, act on `@manso` / `@update-knowledge` / `@update-agent`. |
| `review-pull-request` | Proactively review the full PR; produce `code-review.json/md`, inline findings on validated left/right diff lines and one advisory summary for overall results/unlocated findings. Honors redaction, cost budgets, and audit persistence. `--no-comment` / `--dry-run` disable all posting. |
| `generate-release-notes` | Researcher → exclusion of not-done / not-delivered tickets → PR diff summarisation → LLM-authored prose classified into the team template (New Features / Maintenance / Bug fixes), with ticket links, product affected (Affected services + components), fix version and dates joined from Jira. Writes internal (`release-notes.md`) and external (`release-notes.external.md`) notes; the internal format is optionally posted as a Jira comment. **Monthly mode** (`--project --issueType --date [--jql] [--concurrency]`) finds every release completed in a month (by "Change completion date", else resolved), builds each in parallel with its own provider, adds an LLM month summary, and writes one JSON pack with every release plus aggregated internal/external markdown under `<PROJECT>-<YYYY-MM>/`. |
| `eval` | Score golden `TestDesignPack`s against the quality gate; exit non-zero on failure (release check). |
| `audit` | Read Manso's append-only redacted audit log (`manso audit --log <path>`). |

Global behavior: `--version`, `--help`, unknown-command handling, `CliError`
mapping to exit code 1, and **telemetry flush on exit** (success and error).

### Optional cross-repository memory

[Memory Cabin](./MEMORY-CABIN.md) is an explicitly enabled supporting store:
redacted `latest` snapshots plus timestamped artifact runs, filesystem or Git
delivery with PR fallback, and bounded curated `knowledge/*.md` prompt context.
Local `.agents/memory/` remains primary. Disabled/help/dry-run invocations do
no cabin I/O; failures warn by default with an optional strict mode. Operations
reuse Manso's existing redaction and audit infrastructure.

---

## 2. Context layer (the "Researcher")

The Researcher (`src/agents/researcher/`) assembles a Zod-validated
**`ContextPack`** from a ticket. Every external call records provenance
(`{method, toolName, calledAt, success}`) and non-fatal failures become
`warnings[]` rather than crashing the run.

### 2.1 Jira / Confluence ingestion ✅
- Jira Cloud REST v3 for the issue, comments (paginated), attachments, links.
- Jira GraphQL `developmentInformation` for branches + pull requests.
- Confluence REST to hydrate linked pages (optional creds).
- A pluggable **`ContextProvider`** seam (`src/context/providerRegistry.ts`) —
  the REST provider is the first implementation; others (Rovo MCP, GitHub) drop
  in without touching the agents.

### 2.2 ADF → Markdown fidelity (M10b) ✅
`src/shared/adf.ts` converts Atlassian Document Format to **structure-preserving
Markdown** instead of flattening it: tables → pipe tables, panels → labelled
blockquotes, bullet/ordered lists, headings, fenced code, task lists, and inline
marks (bold/italic/code/strike/links). `extractAdfLinks()` harvests inline +
smart-card links. Applied at the single `unknownToText` choke point, so
descriptions, comments, **and** Confluence bodies all gain fidelity — directly
lifting AC-extraction quality.

### 2.3 Richer linked-ticket context (M10c) ✅
The Researcher expands the **bodies** of related tickets — epic/parent (surfaced
from `fields.parent`), subtasks (`fields.subtasks`), and linked stories/bugs —
into `ContextPack.relatedTickets[]`. Bounded (default 12) with a visible warning
when capped (no silent truncation). Linked **Test** issues route to
`xrayTestCases[]` instead, feeding dedup (§3.5).

### 2.4 Evidence graph (M10d) ✅
`buildEvidenceGraph(context)` produces a typed node/edge traceability graph:
- **Nodes:** ticket, requirement (AC), comment, confluencePage, related ticket,
  xrayTest, attachment, branch, pullRequest.
- **Edges:** `specifies` (→AC), `discussedIn`, `documentedBy`, `coveredBy`,
  `hasAttachment`, `implementedIn`, the link relationship, and `evidencedBy`
  (AC → the source it came from).

Built by the Researcher (base) and rebuilt by the Test Architect once ACs exist.
Idempotent, de-duplicated, schema-validated, rendered in `context.md`.

### 2.5 Attachment understanding (M10e) ✅ / 🔌
- **Download seam:** optional `ContextProvider.fetchAttachmentContent` +
  `AtlassianRestClient.getBinary` with a **same-origin credential guard** (the
  Jira token is only sent when the attachment URL shares the Jira origin).
- **Text attachments (M10e-1):** `.txt/.md/.csv/.json/.feature/.yaml/...` are
  downloaded and decoded into `attachment.analysis` (`text-extraction`).
- **Image attachments (M10e-2):** mockups/screenshots are described by a vision
  model into `attachment.analysis` (`vision`) — bounded by `maxImages` (6) and
  `maxImageBytes` (5 MB). Requires a multimodal LLM (🔌 live).
- All bounded with warnings (cap / oversize / download failure / no capability).

### 2.6 Knowledge index + retrieval (M10f) ✅
`src/context/knowledgeIndex.ts` chunks the whole corpus (description, comments,
Confluence, related-ticket bodies, attachment analyses) and ranks chunks with
**BM25** — deterministic, no embedding API. `searchCitations` projects hits into
`RetrievalCitation`. `buildKnowledgeIndex` caches by a **freshness key**
(ticket + section sizes + generation time).

### 2.7 Tool-using Researcher (M10g) ✅ / 🔌
`runAgenticRetrieval` (`src/agents/researcher/agenticRetrieval.ts`) is a bounded
JSON tool-loop where the LLM drives retrieval:
- `search_context(query, topK)` over the BM25 index,
- `expand_ticket(key)` for available linked (non-test) tickets,
- `finish()`.

Robust action parsing, a step budget with warning, citation dedup, and refusal
of arbitrary/Test keys. Opt-in via `design-tests --deep`; enriches
`retrievalCitations` + `relatedTickets` and rebuilds the evidence graph before
design. The loop is unit-tested with a scripted stub LLM; real model behavior is
🔌 live.

---

## 3. Test design engine (the "Test Architect")

`src/agents/testArchitect/` runs a two-pass LLM design and emits a Zod-validated
**`TestDesignPack`**.

### 3.1 AC extraction ✅
Pass 1 extracts atomic acceptance criteria (`AC-n`) from the ContextPack, driven
by the packaged `acceptance-criteria-extraction` skill. Stored on
`ContextPack.acceptanceCriteria[]`.

### 3.2 Scenario authoring — gherkin / plain-english ✅
Pass 2 designs scenarios covering those ACs. The `testDesign.outputMode` config
selects the mode (default is always `gherkin` unless explicitly set to
`plain-english`):
- **`gherkin`** (default) → Given/When/Then scenarios via the `gherkin-authoring`
  skill; written as `.feature` files; uploaded to Xray as **Cucumber** tests.
- **`plain-english`** → manual test cases (action / expected-result steps) via
  the `plain-english-test-authoring` skill; written as `manual-tests.md`;
  uploaded to Xray as **Manual** tests (M19).

Scenarios are a discriminated union (`TestScenario = Gherkin | PlainEnglish`).
Shared structured fields (`acIds`, `risk`, `readiness`, `sourceEvidence`,
`rationale`, tags) work uniformly, so the coverage gate, risk ranking, and tag
conventions apply across both modes.

### 3.2b Schema-constrained passes (M24) ✅
Every design LLM pass (AC extraction, both authors, derived requirements,
critique) runs through `generateStructured` (`src/integrations/llm/structured.ts`):
the pass's **Zod contract is converted to JSON Schema** (`z.toJSONSchema`) and
sent as OpenAI `response_format: json_schema` / Anthropic **forced tool-use**,
so providers produce conforming JSON instead of prose-wrapped guesses
(array-rooted contracts travel in an object envelope; unsupported deployments
fall back to plain text transparently). If a response still fails to parse or
validate, the model gets **one corrective re-prompt carrying the exact
validation issues** before the pass gives up — a malformed pass no longer
silently drops scenarios. Transport errors are not re-prompted. `design-tests`
reports the pass health per run (`Structured outputs: N pass(es), R retried,
F failed`).

### 3.3 Tag conventions ✅
Enforced by `normalizeScenarioTags`:
- **Feature-level tag** is the Jira key only — `@QATG-1234` (not `@story-...`).
- **Scenario tags** are feature-area labels (`@login`, `@checkout`).
- **`@smoke`** is auto-derived for `risk: "high"` (not hand-tagged).
- **Stripped:** `@AC-n`, `@high/@medium/@low`, `@positive/@negative`,
  `@story-*`.

### 3.4 Coverage gate (M7) ✅
The Coverage Auditor (`src/agents/coverageAuditor/`) enforces "every AC has ≥1
scenario" per `policy.gates.acCoverage` (`required` / `warn` / `off`). On gaps it
runs **one bounded retry** scoped to the uncovered ACs. ACs covered by existing
tests (`acsCoveredByExisting`) count as covered — the gate never forces a
duplicate.

### 3.4b Requirement coverage beyond ACs (M22) ✅
The literal acceptance criteria are the *stated* contract, not the whole
requirement — and the AC gate only measures that floor. M22 adds, all config-gated:
- **Derived-requirement extraction** (`extractDerivedRequirements`) mines the full
  context for implied behaviours the ACs don't state — error/boundary/security/
  data/state — emitting `derivedRequirements[]` (`{id, text, category, risk,
  sourceEvidence}`) as additional coverage targets, kept separate from the ACs so
  the product contract stays honest. Resilient: warns + yields `[]` on failure.
- **Structured `polarity` + `drIds` on scenarios** (`positive`/`negative`/
  `boundary`) so coverage *quality* is machine-checkable, not tag-guessed.
- **Risk/edge coverage gate** (`auditRiskCoverage`): a high-risk AC or derived
  requirement is unsatisfied unless covered by a negative-or-boundary scenario;
  an uncovered derived requirement is a gap. `policy.gates.riskCoverage` =
  `required | warn | off` (**default `warn`**). Results land in
  `riskCoverageMatrix` + the design `.md`.
- **Adversarial critique** (`critiqueDesign`) — one bounded "what did this design
  miss?" pass that folds in genuinely-missing scenarios (no duplicates) and
  records the rest as gaps / open questions.
- Knobs: `policy.design.deriveRequirements`, `policy.design.adversarialCritique`,
  `policy.gates.riskCoverage`. The CLI resolves them with **one default for every
  run shape** (`resolveM22Options`: flag → repo config → **on**, gate `warn`), so
  a repo-less Jira-rule run behaves identically to a repo-backed one. The two
  extra LLM passes are metered by the budget engine (§9.1).

### 3.4c Learned rules feed the design (M25) ✅
When a repo is resolved (`--repo` or the ticket's dev section), a shared,
bounded loader (`src/context/repoGuidance.ts`) reads `AGENTS.md`, the
`.agents/` docs, **and `.agents/guidelines/*.md`** — the rules the learning
engine proposes and humans merge — and injects them as a "Team conventions &
learned rules" section into all three authoring prompts (Gherkin,
plain-English, critique). The implementer consumes the same loader, so a
merged guideline now improves both future *designs* and future *code*.
(Before M25 the guidelines directory was written but read by neither side.)

### 3.5 Reuse + de-duplication ✅
Three design-quality features feed the author so it builds on what exists:
- **Step-library reuse (M10a):** scans the target repo's `.feature` files for
  existing step phrasings and feeds them to the author to reuse, not duplicate.
  Repo resolved from `--repo` or the ticket's dev section via
  `MANSO_REPO_ROOTS`.
- **Scenario-title dedup:** existing scenario/outline titles are surfaced so the
  author won't re-author an equivalent case.
- **Linked-Xray-test dedup:** Xray Test issues linked to the story are listed in
  the prompt; the author marks an already-covered AC as `acsCoveredByExisting`
  instead of duplicating. At upload the sink also dedups by a **normalized title**
  (`normalizeTestTitle` — case/punctuation/unicode-insensitive) against both the
  already-linked tests **and** the other scenarios in the same run, so a reworded
  title can't slip a near-duplicate past the exact-match check. The critique pass
  and the `--issue` repo diff share the same normalizer.

### 3.6 Outputs ✅
`out/<KEY>/`: `test-design.json` (+`.md`) and one `.feature` file per Feature.
`context.json` (+`.md`) carries the enriched ContextPack.

---

## 4. Xray sink (M8) ✅

`src/integrations/xray/` creates each scenario in Xray Cloud (GraphQL) and links
it to the story via the configured link type (defaults to **"is tested by"**):
Gherkin scenarios become **Cucumber tests**, plain-English scenarios become
**Manual tests** (their action / expected-result steps map to Xray manual steps,
M19). **Idempotent** by normalized title (§3.5), against both linked tests and
the run's own scenarios. Gated by `--dry-run` / `--yes` and
`policy.gates.humanReviewBeforeUpload`. Records Xray keys back into the pack.

**Project-mandatory fields & attribution.** Created Test issues satisfy a
project's required fields three ways, least- to most-specific: the sink
**inherits** the story's primitive required fields (denylisting structural ones
like `project`/`issuetype`/`reporter`); a **`--reporter <accountId>`** flag sets
the Reporter (e.g. a Jira rule passing `{{initiator.accountId}}`, so tests are
attributed to the triggering QA — needs the *Modify Reporter* project
permission); and a raw **`--test-fields '{...}'`** / `xray.testFields` blob for
structured fields like a Tempo account (`mergeTestFields` layers them, the blob
winning). See `docs/JIRA-AUTOMATION.md` for finding a field's id/write-shape.

---

## 5. Implementation engine

`src/agents/implementer/`, `verifier/`, `healer/` + `src/cli/implementTests.ts`.

### 5.1 Code agent (M9) ✅ / 🔌
Builds an implementation prompt from the TestDesignPack + the chosen **binding
skill** (`playwright-bdd-ts`, `dotnet-reqnroll`) + `.agents/` guidance files, then
runs the code agent. Three runner backends behind one interface
(`ImplementationAgentRunner`): **Claude Agent SDK**, **Codex SDK**, and a
**Shell** runner. Maps each scenario to an `ImplementedScenario` outcome.

### 5.2 Verify + heal loop (M9b) ✅
The Verifier runs the stack's `verifyCommand`. On failure the Healer builds a
narrow "repair only the failing tests" prompt and re-runs verification, up to
`--max-heal-attempts` (default 1). Final status is `completed` / `partial` /
`failed` / `dry-run`. **Crash-rescue:** if the code agent exits non-zero (e.g. a
transport drop at the end of its turn) but **verify passed and files changed**,
the run is rescued to `partial` with an explanatory warning so the commit/PR
still proceed for human review — a finished implementation is never silently
discarded. A crash with a red verify, or with no changed files, still reports
`failed`.

### 5.3 Branch, commit, PR (M9c, M17) ✅ / 🔌
`commitChangesOnBranch` creates a branch named after the issue key (e.g.
`FINT-1056`), commits, optionally pushes. The **`VcsAdapter`** seam raises the
PR with two implementations: **`AzureDevOpsAdapter`** and **`GitHubAdapter`**
(github.com + Enterprise). The CLI auto-detects the platform from
`git remote get-url origin` via `resolveVcsAdapter` and uses the matching token
(`AZURE_DEVOPS_PAT` / `GITHUB_TOKEN`). PR status: `raised` / `exists` /
`failed` / `dry-run`. Produces an `ImplementationPack` (changed files, verify
result, heal attempts, PR reference, prompt path).

#### Token-based push for unattended / pipeline runs ✅
The VCS token authenticates **both** the REST API (PR create, comments) **and
the `git push`** — so a clean pipeline agent needs no pre-configured git
credentials. `resolveGitPushAuth` inspects `origin` and builds a
`GitPushAuth` header that the push injects via `git -c http.extraHeader=…`:

| Remote | Auth scheme |
|---|---|
| GitHub (github.com / Enterprise) | HTTP Basic, user `x-access-token`, token as password |
| Azure DevOps | HTTP Basic, empty user, PAT as password |

The token is passed via `http.extraHeader` (never baked into the `origin` URL),
and the executed command is logged in **redacted** form
(`git -c http.extraHeader=<redacted:github (token)> push …`) so secrets never
reach the run report. When **no matching token is set, the push falls back to
the host's local git credentials** (credential helper / SSH key) — a local
developer is unaffected. The same auth is threaded through the implementation PR
(`implement-tests`) and the guideline-proposal PRs (`respond-to-pr`,
`@update-knowledge` / `@update-agent`).

#### Stateless implement from Xray (`--issue`) ✅
`implement-tests` accepts **`--issue <KEY>` as an alternative to `--design <file>`**
(exactly one is required). Instead of a local design pack it reconstructs the
work from Xray — `fetchLinkedCucumberTests` reads the story's linked Test issues
(Jira issue links) and pulls each one's Gherkin via an Xray `getTests` query;
`parseGherkinScenario` (the inverse of `renderScenarioGherkin`) turns each body
back into a structured scenario; it then diffs against the repo's existing
`.feature` scenario titles (`extractStepLibrary`) and implements only the
missing ones, assembling a minimal `TestDesignPack`. Nothing missing → exits 0
("nothing to implement"). This makes the implement step **stateless**, so a
pipeline job can run it on its own (no artifact hand-off from the design run) —
see `docs/PIPELINE.md`. **`--require-linked-tests`** turns "the story has *zero*
linked tests" into a hard failure instead of a quiet green no-op (the pipeline
implement step sets it, since design is expected to have run first); otherwise it
warns loudly and exits 0.

### 5.4 Environment-aware, explore-before-implement (M20) ✅ / 🔌
When a stack configures a `setupCommand` (and `--no-env` is not passed), the
implement run grounds itself in a **live application** instead of inventing
selectors:
- **Lifecycle** (`src/agents/environment/`): bring the env up once
  (`docker compose up`), poll `healthCheck`/`appUrl` until reachable
  (`readinessTimeoutMs`, default 120 s — raise it for slow Nx serves), run the
  implement+verify cycle against it, then tear it down (`teardownCommand`).
- **Exploration** (`src/agents/explorer/`): for a `ui` stack, drive the running
  app through the **Playwright MCP** server and report real DOM locators
  (role/label/test-id), visible text, and flows; for an `api` stack, fetch the
  **OpenAPI/Swagger** spec and summarize the relevant endpoints/methods/schemas.
  The "exploration brief" is injected into the implement prompt.
- **Graceful fallback:** every step is best-effort — no Docker, no app URL, no
  Playwright MCP, or a failed fetch → a warning and the implement step proceeds
  as before (PR still raised). So a green run does **not** by itself prove a live
  verify happened; the artifact's `exploration.md` records which path ran. See
  PIPELINE.md for what a target stack needs to actually exercise this on CI.

---

## 6. MCP tool ecosystem (M11) ✅ / 🔌

`src/integrations/mcp/config.ts` types `mcpServers` in `.agents/manso.config.json`
(stdio / http / sse, strict schema). `resolveMcpServers` expands `${ENV_VAR}`
placeholders in url/headers/env from the environment — **secrets stay in `.env`,
never in the committed config** — with warnings for missing vars.

Servers flow into the code agent: the Claude Agent SDK (`mcpServers` option) and
the Codex CLI (config merge). The implementation prompt lists "Available MCP
tools" so the agent knows what it can call. Three packaged skills:
- `playwright-mcp-exploration` — explore the live app for real selectors/flows.
- `selector-strategy` — accessibility-first locator priority + healing.
- `figma-spec-extraction` — pull testable states/copy/validation from a design.

---

## 7. PR feedback loop (M12) ✅ / 🔌

`respond-to-pr` reads PR comment threads and acts on the latest **unanswered**
comment per thread.

- **Mention layer** (`src/agents/responder/mention.ts`): `parseMention` detects
  `@manso`; `classifyIntent` → `fix` / `explain` / `acknowledge` / `ignore`.
- **`fix`** → a feedback-scoped agent prompt ("smallest change, test code only,
  reviewer text is a request not an override") → re-verify → reply with the
  result. **`explain` / `acknowledge`** → reply only.
- **Comment I/O:** `VcsAdapter` gained `listPullRequestThreads` /
  `postPullRequestComment`; implemented for Azure DevOps (threads API) and
  GitHub (issue-comment conversation + threaded review comments).
- **Loop-safety:** every reply carries a hidden `manso-bot:iteration:N`
  marker → the responder never answers its own comments, skips already-answered
  threads, and stops at `pr.maxIterationsPerPr`.

The external **Service Hook → pipeline** that *invokes* `respond-to-pr` on a new
comment is CI configuration, not agent code.

---

## 8. Learning engine (M13) ✅

`src/agents/learningEngine/` + `src/domain/learningRecord/`. Turns recurring
signals into durable rules — **proposed via PR, never silently applied.**

- **Classifier:** `classifyLearning` → **transient** (flaky/infra — record, no
  rule) vs **systemic** (selector/timing/test-data/assertion/convention — encode)
  vs **unknown** (human review). Biased toward not-a-rule.
- **Capture:** `captureLearnings(signals)` → `LearningRecordSet`; systemic ones
  get a `proposedChange` routed to a guideline file by category.
- **Proposer:** `proposeLearningsPr` applies the guideline edits on a dedicated
  branch and raises a **separate, human-reviewed PR** (skips when nothing
  systemic; dry-run writes edits without a PR). `applyGuidelineEdits` is
  idempotent and creates files with a "review before merging" provenance note.
- **Writer:** `learnings.json` + `.md` (durable per-run learning artifact).
- Packaged `learning-capture` skill encodes the policy (never propose a rule
  that weakens tests; no secrets).

### 8.1 Knowledge-update triggers (M13e) ✅ / 🔌
Two explicit PR-comment handles route a correction to the right scope:
- **`@update-knowledge <rule>`** → project knowledge → review PR editing the
  target repo's `.agents/guidelines/<topic>.md`.
- **`@update-agent <rule>`** → general rule → review PR editing Manso's own
  `proposed-guidelines/<topic>.md` (a maintainer folds it into a packaged skill).
  Requires `MANSO_AGENT_REPO` (a local Manso checkout); refuses cleanly
  when unset.

Wired into the responder (takes priority over `@manso`, loop-safe). The
category classifier routes to the file; the tag picks project vs agent scope.

---

## 9. Governance + eval (M14)

### 9.1 Policy Engine ✅
- **Redaction** (`src/policy/redaction.ts`): `buildRedactor` scrubs secrets/PII
  (API keys, bearer/basic auth, private keys, emails, `key=value` secrets) +
  `policy.redactPatterns`; invalid custom patterns are skipped. Applied before
  text reaches logs/telemetry/artifacts and the audit log.
- **Cost budgets, metered everywhere (M15)** (`src/policy/budget.ts`,
  `costLedger.ts`, `modelPrices.ts`): `design-tests` and `implement-tests` record
  each run's spend in an append-only **cost ledger** (`MANSO_COST_LEDGER`),
  then `checkBudget` evaluates run + day spend vs `policy.budgets` and warns +
  emits `budget.breached` on a breach. Cost comes from a **configurable model
  price table** (`resolveModelPrice`, overridable via `MANSO_MODEL_PRICES`)
  through a **cache-aware estimator**: an exact SDK-reported cost wins, otherwise
  tokens × price with cached input billed at the cached rate. This closes two
  blind spots — the Codex SDK (reports tokens, no cost) and the **design phase**
  (the text clients accumulate token usage via `getAccumulatedUsage`). Unknown
  models log token totals with a hint rather than silently counting 0.
- **Audit log, emitted at every mutating action (M16)** (`src/policy/auditLog.ts`):
  append-only **redacted** JSONL written at `run.started`, `design.created`,
  `xray.uploaded`, `pr.raised`, `rule.proposed`, `budget.breached`, and
  `run.completed`; `readAuditLog` parses it and the `audit` verb prints it. On
  ephemeral CI agents point `MANSO_AUDIT_LOG` at the published artifact.

### 9.2 Eval harness ✅
- **`scoreTestDesign`** — deterministic weighted quality score (0–100) over AC
  coverage, traceability, tag hygiene, scenario structure, title uniqueness, and
  strategy presence. Reproducible → regressions are attributable to a dimension.
- **Reference recall (M23)** — a golden case may carry the **human-written**
  test list for the same ticket (`<name>.reference.json`, e.g. a QA's scenario
  table from a Jira comment); `matchAgainstReference` measures the design's
  **semantic recall** against it deterministically (stemming + corpus stopwords
  + blended containment/Dice similarity, greedy 1:1 — tuned on the real
  MPORTAL-2073 pair) and the report lists the **missed reference cases**. Extra
  scenarios beyond the reference are reported but never penalized (that's M22
  working as intended).
- **`runEval`** — a **release gate**: passes only when the mean clears the
  threshold, no case is below the floor, *and* every reference-carrying case
  clears `--min-recall` (default 60%). **`analyzeVariance`** measures
  run-to-run consistency.
- **`eval` verb** loads golden cases from `--cases` (see `eval/cases/README.md`),
  scores, prints a report, and **exits non-zero on failure** — wired into
  `.github/workflows/ci.yml` as the CI release gate (no LLM/creds needed).

### 9.3 SLO dashboard 🔌
Observability is already emitted (§11); the dashboard is the external
Phoenix/Langfuse UI pointed at the project — no extra code.

---

## 10. Configuration & skills

### 10.1 Runtime config ✅
`src/config/runtimeConfig.ts` — env + optional JSON. Secrets via `.env`
(gitignored): `JIRA_*`, `XRAY_*`, `AZURE_DEVOPS_PAT`, `GITHUB_TOKEN` (or
`GH_TOKEN`) — each used for both REST and `git push` auth; LLM provider/keys with
a **separate design vs implementation LLM** (`LLM_*` and `IMPLEMENTATION_LLM_*`,
including `*_BASE_URL` for Azure-hosted models); `OTEL_*`; `MANSO_SANDBOX`;
`MANSO_AGENT_REPO`; `MANSO_REPO_ROOTS`; `MANSO_AUDIT_LOG` /
`MANSO_COST_LEDGER` (durable governance paths); `MANSO_MODEL_PRICES`
(price-table overrides). A Codex base URL on a `*.services.ai.azure.com` host is
**warned about at startup** (its WebSocket replies 302; use the
`*.openai.azure.com/openai/v1` host instead).

### 10.2 Agent config ✅
`.agents/manso.config.json` (Zod-validated): `product`, `testDesign`,
`stacks[]`, `context`, `mcpServers`, `xray`, `policy` (gates, budgets,
redactPatterns), `pr` (mention, maxIterationsPerPr).

### 10.3 Skills (progressive disclosure) ✅
`src/skillLoader/` parses `SKILL.md` frontmatter (`name`, `description`,
`appliesTo {stacks, phase}`, `when`). Resolution: repo `.agents/skills/<name>`
**overrides** packaged `skills/<name>`. Filtered by `{phase, stack}`. Nine
packaged skills today: `acceptance-criteria-extraction`, `gherkin-authoring`,
`plain-english-test-authoring`, `playwright-bdd-ts`, `dotnet-reqnroll`,
`playwright-mcp-exploration`, `selector-strategy`, `figma-spec-extraction`,
`learning-capture`.

### 10.4 Sandbox seam (M13d) ✅
`src/integrations/llm/sandbox.ts` — a named `SandboxProfile`
(`danger-full-access` | `workspace-write` | `read-only`) resolved via explicit
arg → `MANSO_SANDBOX` → default. The runners no longer hard-code permissive
settings; the default preserves behavior, CI can dial it down. (Devcontainer/
Dagger execution is roadmap.)

---

## 11. Observability ✅

`src/integrations/llm/telemetry/observability.ts` — OpenTelemetry +
OpenInference auto-instrumentation for OpenAI and Anthropic, targeting **both
Phoenix and Langfuse**. Captures token usage, latency, model, and prompt/output
per LLM call; groups a run into a **session per Jira issue**; workflow spans for
each agent. The **agentic phases** (implement, heal, and `respond-to-pr` fixes)
run through the Claude/Codex SDK, which OpenInference doesn't auto-instrument —
so they're emitted as explicit Langfuse **generations** with token usage and an
**exact-or-estimated cost** (`cost_details`), including the cached-input /
reasoning-token split so Langfuse's own tokens×price inference can't over-count
(it previously over-stated a cached-heavy Codex run ~4×). Spans are **flushed on
CLI exit** (success + error). No-op unless `OTEL_ENABLED=true`. Turn-key
Langfuse: set `OTEL_PROVIDER=langfuse` + `OTEL_PUBLIC_KEY`/`OTEL_SECRET_KEY`
(blank endpoint → Langfuse Cloud). The pipeline runs a **Langfuse egress check**
so a blocked endpoint surfaces instead of silently dropping traces.

---

## 12. Artifact contracts (the backbone) ✅

Every stage emits a Zod-validated artifact in `src/domain/` with
`schemaVersion` + `provenance` + `warnings`:

| Artifact | Stage |
|---|---|
| `ContextPack` | Researcher |
| `TestDesignPack` | Test Architect |
| `ImplementationPack` | Implementer/Verifier/Healer |
| `LearningRecordSet` | Learning engine |
| `ReadinessReport` | `check` |
| `EvalReport` | eval harness |

"Agentic core, bounded artifacts": agents are free-form internally, but every
hand-off is a typed, validated schema written to `out/<KEY>/`.

---

## 13. Roadmap (next milestones)

Detailed specs: **[ROADMAP.md](./ROADMAP.md)**.

| ID | Milestone | What it adds |
|---|---|---|
| ✅ M22 | Requirement coverage beyond ACs (risk- & edge-aware design) | Extract **derived requirements** the ACs don't state (error/boundary/security/data), add a second **risk/edge coverage** gate dimension (scenario `polarity` + `drIds`), and a bounded **adversarial "what did we miss?"** pass — so exploratory coverage is measured, not just hoped for. **Done.** |
| ✅ M20 | Environment-aware, explore-before-implement | Spin up the app (Docker) once per run; explore the live UI (Playwright MCP → real DOM locators) or API (OpenAPI/Swagger → endpoints + schemas) to ground the tests; implement → verify against the running env → tear down. **Done.** |
| ✅ M17 | GitHubAdapter | `VcsAdapter` for GitHub (PR raise + comment threads) + `detectGitHubRemote` + `resolveVcsAdapter` remote routing. **Done.** |
| ✅ M15 | Budget enforcement wiring | `checkBudget` wired into design + implement with a cost ledger and a cache-aware model price table; warn + `budget.breached` on a breach. **Done.** |
| ✅ M16 | Audit emission wiring | `emitAudit` at each mutating action (run/design/upload/PR/propose/breach); `manso audit` reader. **Done.** |
| ✅ M19 | Xray Manual-test upload | Plain-English scenarios upload to Xray as Manual tests (action/expected steps → manual steps), linked like Cucumber tests. **Done.** |
| ✅ M23 | Golden eval set + regression harness | Golden cases from real runs with **human-written references**; deterministic semantic **recall** scoring + missed-case reporting; `--min-recall` release gate wired into CI. **Done.** |
| ✅ M24 | Schema-constrained design passes | All five design passes generate against their Zod contract (OpenAI json_schema / Anthropic forced tool-use, graceful fallback) + one corrective re-prompt carrying the validation error; parse-failure stats reported. **Done.** |
| ✅ M25 | Close the learning loop into design | A shared guidance loader now feeds `AGENTS.md`, the `.agents/` docs, **and `.agents/guidelines/*.md`** (previously read by *neither* side) into both the design prompts and the implementer, bounded with warnings. **Done.** Stretch (open): mine Xray edits humans make to agent tests into learning candidates. |
| ✅ M26 | Design revision mode | A re-run semantically compares the fresh design against the story's linked tests: keeps what's covered, adds what's new, and reports agent-created tests the design no longer covers as **retire candidates** via a Jira comment (never auto-deleted). **Done.** |
| 🗺️ M27 | Test maintenance loop | Consume Xray/CI execution results for authored tests; triage flaky vs broken vs obsolete; auto-open heal PRs. Authoring → lifecycle ownership. |
| 🗺️ M28 | Workflow-layer extraction | Pure refactor: orchestration + a shared `withGovernance()` out of the CLI verbs; unify the token-usage types. |
| 🗺️ — | Devcontainer/Dagger sandbox | Execute the code agent inside an isolated container mapped to the sandbox profiles. |
| 🗺️ — | More stacks | Cypress + others: each is one binding skill + one verify config + one eval repo. |

---

## Test coverage

425 tests across 55 files (fixture- and mock-based; no network). Every `runX`
library entry point is tested through its inputs; pure cores (ADF, evidence
graph, BM25, classifiers, scorer, policy, model pricing, title normalization,
Gherkin round-trip, VCS URL parsing) have dedicated unit suites. The build gate
is `npm run check && npm test`.
