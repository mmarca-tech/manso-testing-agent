# Manso — Solution Evaluation

An honest assessment of the solution: what it is, what it does well, the issues
found, and where to invest next. Items marked **observed** were reproduced on
real runs (FINT‑1056, MPORTAL‑2073, DATAEX‑520) during this evaluation cycle;
the rest were found by code inspection.

> **Status (2026‑06‑05):** all **P1** (correctness), **P2** (cost/governance),
> and **P3** (environment/pipeline) findings are **resolved or mitigated** —
> see the resolution columns below. Remaining **org actions** (not code):
> a hermetic/self‑hosted M20 target (#8), one live verification of the
> `openai.azure.com` Codex endpoint (#10), and the `Manso` Jira service
> account (#11). The minor notes remain open.

---

## 1. Purpose — what this solution is

Manso is an **AI testing agent** that closes the loop from *requirement* to
*verified automated test*:

1. **Context** — a Researcher pulls everything about a Jira story (description,
   comments, attachments with vision, linked/related tickets, Confluence,
   dev links) into a bounded, validated **ContextPack**.
2. **Design** — a Test Architect extracts acceptance criteria, mines **derived
   requirements** beyond them (M22), authors Gherkin (or plain‑English)
   scenarios with structured coverage/risk/polarity metadata, gates coverage,
   and uploads the result to **Xray** as Cucumber/Manual tests linked
   *"is tested by"* to the story.
3. **Implementation** — a code agent (Claude/Codex SDK) implements the
   scenarios in the target repo (optionally against a **live, Docker‑spun
   environment** it has explored first — M20), verifies, self‑heals, commits,
   and raises a **PR**.
4. **Feedback & learning** — `respond-to-pr` acts on `@manso` review
   comments; a learning engine captures durable lessons.
5. **Operations** — the whole flow runs **unattended** from Jira automation
   rules via one parameterized Azure pipeline, with Langfuse observability,
   cost budgets, audit logging, and redaction.

The core design idea — **an agentic core with bounded Zod artifacts** between
every stage — is what makes the pipeline inspectable and testable.

## 2. What is genuinely strong

- **Artifact discipline.** Every hand‑off (ContextPack, TestDesignPack,
  ImplementationPack) is schema‑validated, persisted, and human‑readable.
  Failures are visible in artifacts rather than swallowed.
- **Coverage is measured, not hoped for.** The AC gate (floor) plus M22's
  risk/edge gate (negative/boundary coverage for high‑risk targets) turn
  "the LLM probably covered it" into checkable invariants. Live result: the
  same story went from 10 happy‑path tests to 28 scenarios covering the QA's
  full hand‑written list once context + M22 landed.
- **Resilience posture.** The optional passes (derived requirements, critique,
  environment, vision) all degrade gracefully — warn and continue, never block
  the run. Right default for an unattended tool.
- **Stateless pipeline design.** `implement --issue` reconstructs the design
  from Xray, so each Jira rule is an independent run — no artifact passing
  between pipelines.
- **Operational maturity for its age.** Idempotency pre‑checks (normalized,
  not exact‑title), link‑direction resolution, project‑mandatory‑field handling
  (inherit + override + per‑run `testFields`), per‑QA `reporter` attribution,
  host‑aware git auth via `http.extraHeader` (tokens never in URLs/logs),
  credential‑scoped binary downloads, audit log, secret redaction, cost
  metering with a configurable model price table, loud guards for known
  misconfigurations (`--require-linked-tests`, the Azure Foundry WebSocket
  host), an eval harness, and 425 unit tests.

## 3. Issues & bugs

### P1 — correctness / silently wrong results — **all resolved 2026‑06‑05**

| # | Issue | Resolution |
|---|---|---|
| 1 | **`implement --issue` found 0 linked tests on FINT‑1056.** | **Root‑caused: not a code bug.** The June‑3 "0 links" was a point‑in‑time truth — the ticket's original tests had been deleted and the current ones not yet created; a live re‑probe fetched **27/27** linked Cucumber tests with Gherkin, zero warnings. (The "design sink saw a link" premise misread dry‑run output, which marks everything `skipped-existing` without listing links.) The *systemic* risk — a green no‑op when design never ran — is now guarded: a loud warning when 0 linked tests are found, and a **`--require-linked-tests`** flag (wired into the pipeline implement step) that fails the run instead. |
| 2 | **A transport failure buries a finished implementation.** (Correction to the original write‑up: commit/PR was **never** status‑gated — the defect was that `deriveFinalStatus` reported **failed** → CLI exit 1 → red pipeline, even when verify passed with changed files; and local runs without `--pr` simply discarded the signal.) | **Fixed:** when the agent exits non‑zero but verify passed **and** files changed, the run is rescued to **`partial`** with an explanatory warning — commit/PR proceed and the pipeline stays green for human review. Crash‑with‑red‑verify and crash‑with‑no‑changes still report `failed`. Covered by `test/implementRescue.test.ts`. |
| 3 | **Duplicate test cases across re‑runs / within a run.** | **Fixed:** shared `normalizeTestTitle` (case/punctuation/unicode‑dash/whitespace‑insensitive) now backs the sink's idempotency check **and** a new within‑run dedup (two same‑normalized scenarios in one design create one test), the critique pass (incl. dedup among its own proposals), and the `--issue` repo diff. Semantic ("reworded meaning") dedup remains a future enhancement; *fire design once per ticket* stays the operational guidance. |
| 4 | **`respond-to-pr` untraced.** | **Fixed:** the fix‑agent run now routes through `runImplementationAgent` with `runtime.observability.telemetry` threaded from the CLI — PR‑fix runs get a Langfuse session + usage/cost like implement/heal. |

### P2 — cost & governance blind spots — **all resolved 2026‑06‑05**

| # | Issue | Resolution |
|---|---|---|
| 5 | **Budget enforcement is blind to Codex and to design.** | **Fixed:** a configurable **model price table** (`src/policy/modelPrices.ts`; defaults for gpt‑5.3‑codex/chat, gpt‑5.5, Claude Sonnet/Haiku/Opus; extend via `MANSO_MODEL_PRICES`) backs `estimateUsageCostUsd` — exact SDK cost wins, otherwise a **cache‑aware** tokens×price estimate. `sumUsageCost` uses it, so the run/day caps now see Codex spend. The **design phase is metered too**: the three text clients accumulate token usage from API responses (`getAccumulatedUsage`), and `design-tests` prices the totals, records them in the same cost ledger (`command: "design-tests"`), warns + emits `budget.breached` on a cap breach. Unknown models log token totals with a hint to set `MANSO_MODEL_PRICES` rather than silently counting 0. |
| 6 | **Codex cost over‑stated ~4× in Langfuse** (cached input priced at the full rate). | **Fixed:** the agent generation span now emits `gen_ai.usage.cached_input_tokens` / `reasoning_output_tokens`, and `langfuse.observation.cost_details` carries the exact SDK cost **or** the cache‑aware estimate — overriding Langfuse's own tokens×price inference, which can't see the cached split. The estimator reproduces the observed run: $0.274 vs the $1.03 previously shown (test pins the math). |
| 7 | **M22 defaults differ by run shape.** | **Fixed:** one default everywhere at the CLI — `resolveM22Options` resolves *flag → repo config → ON* (`deriveRequirements`/`adversarialCritique` true, `riskCoverage` **warn**), so a repo‑less rule behaves identically to a repo‑backed one. The library API keeps explicit opt‑in (unchanged for programmatic/test use); repo config or flags can still disable each pass. |

### P3 — environment / pipeline gaps — **addressed 2026‑06‑05** (two carry org follow‑ups)

| # | Issue | Resolution |
|---|---|---|
| 8 | **M20 cannot actually run on the hosted pipeline for the current target** (`general-ledger-e2e` compose: external bind‑mount, no published ports, auth secrets, ~8 min boot). | **Documented as an environmental constraint** — PIPELINE.md now spells out what a target stack needs for env‑aware CI runs (hermetic compose: no external mounts, published host ports, secrets via env, realistic `readinessTimeoutMs`, Docker‑capable runner) and how to tell from the artifact (`exploration.md`) whether a live‑app verify actually happened. *Remaining org action:* make the gle‑e2e compose hermetic, or run implement on a self‑hosted agent with the sibling repo + secrets. |
| 9 | **`run.yml` (ACR variant) lags `run-hosted.yml`.** | **Fixed:** full parity — optional `targetRepo` (conditional clone + git identity), `testFields`/`reporter`/M22 parameters, Langfuse egress check, `--require-linked-tests` on implement, `IMPLEMENTATION_LLM_BASE_URL` mapping, and the cost ledger on the artifact. Both files now carry a "keep in sync" note. |
| 10 | **Codex SDK unusable on Windows; 302 on the Azure AI Foundry WebSocket.** | **Mitigated:** `codexBaseUrlWarning` now warns loudly at startup when the base URL is a `*.services.ai.azure.com` host (the known‑bad WS endpoint) and points at the `openai.azure.com/openai/v1` form. The Windows crash is an **upstream SDK limitation** (use Claude locally, or run Codex via the Docker image); the `openai.azure.com` endpoint still needs one live verification run. |
| 11 | **Shared Jira identity across QAs.** | **Mitigated:** first‑class `reporter` CLI flag + pipeline parameter — a rule passes `{{initiator.accountId}}` and created tests are attributed to the triggering QA (requires *Modify Reporter* permission; Creator remains the shared credential). *Remaining org action:* create the dedicated `Manso` Jira service account and swap the shared token for it. |

### Minor

- Figma **links** in descriptions are not fetched — only pasted screenshot
  attachments are vision‑analysed (worked only after the `Accept: */*` fix).
- `listLinkedTestSummaries` matches issue types by `includes("test")` —
  intentional ("Test"/"Test Case") but loose.
- Unquoted `$REPO_ARG` word‑splitting in both pipeline YMLs relies on the
  cloned‑repo path never containing spaces (true for the Azure‑provided
  workspace paths used today).
- The prompt‑injection surface is real: the implement agent runs with
  `danger-full-access` and secrets in env, fed ticket text written by
  arbitrary Jira users. Redaction + scoped tokens mitigate; worth an explicit
  threat‑model note and least‑privilege PATs.

## 4. Suggested improvements (priority order)

1. ~~**Root‑cause the `--issue` 0‑links discrepancy (P1‑1).**~~ **Done
   2026‑06‑05** — root‑caused (not a code bug) + guarded with a loud warning
   and `--require-linked-tests`.
2. ~~**Don't discard verified work on agent exit≠0 (P1‑2).**~~ **Done
   2026‑06‑05** — rescued to `partial`; commit/PR proceed for review.
3. ~~**Real dedup (P1‑3).**~~ **Done 2026‑06‑05** — normalized‑title dedup at
   upload, within‑run, in critique, and in the `--issue` diff. Still open as a
   *future enhancement*: an LLM "semantically the same test?" check for
   reworded-meaning duplicates.
4. ~~**Trace `respond-to-pr` (P1‑4).**~~ **Done 2026‑06‑05.**
5. ~~**Meter all spend (P2‑5/6).**~~ **Done 2026‑06‑05** — price table +
   cache‑aware estimator feeds the ledger (implement *and* design) and the
   Langfuse span.
6. ~~**Unify M22 defaults (P2‑7)**~~ **Done 2026‑06‑05** — on by default
   everywhere (gate `warn`), flags/config to disable.
7. ~~**Bring `run.yml` to parity (P3‑9).**~~ **Done 2026‑06‑05.**
8. **A self‑contained M20 target.** Requirements now documented in PIPELINE.md;
   the remaining work is in the *target repo* (hermetic compose) or infra
   (self‑hosted agent with the sibling repo + secrets).
9. **Service account** (`Manso` Jira user) for pipeline identity — the
   per‑QA `reporter` parameter (`{{initiator.accountId}}`) is first‑class now;
   the service account remains the proper Creator‑level fix.
10. **Next quality milestones** already specced: API spec‑first exploration
    tiering (committed spec → URL → generate → spin‑up), Figma link fetching
    for design‑time visual context, and semantic test‑title dedup (see 3).

## 5. Quick wins (small effort, high value)

| Win | Effort |
|---|---|
| ~~Route `responder` through `runImplementationAgent`~~ | **done 2026‑06‑05** |
| ~~Emit `gen_ai.usage` cached‑token details for Codex~~ | **done 2026‑06‑05** |
| ~~Normalized‑title dedup in sink + critique~~ | **done 2026‑06‑05** |
| ~~Copy new params/steps into `run.yml`~~ | **done 2026‑06‑05** |
| ~~Warn loudly / `--require-linked-tests` when `--issue` finds 0 linked tests~~ | **done 2026‑06‑05** |
| Document "trigger design once per ticket" in JIRA‑AUTOMATION.md (done) | — |

---

*Written as part of the 2026‑06‑05 review and updated as findings were fixed:
all P1/P2/P3 items are resolved or mitigated (root causes and resolutions
inline above); the remaining follow‑ups are organizational (hermetic M20
target, live `openai.azure.com` verification, `Manso` service account)
plus the minor notes. See [CHANGELOG.md](./CHANGELOG.md) for the full list of
this cycle's changes.*
