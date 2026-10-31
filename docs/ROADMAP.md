# Manso Roadmap

Detailed specs for the milestones not yet built. The shipped work (M0–M14, plus
M17 GitHubAdapter and M18 plain-English) is described in
[FEATURES.md](./FEATURES.md). Status legend: 🔥 high priority · 🗺️ planned.

---

# Next milestones (2026‑07 evaluation)

Findings that drive the ordering (from the July solution evaluation):
**(a)** the eval harness has machinery but **no golden dataset** — outcome
accuracy is currently unmeasured; **(b)** all five design LLM passes parse JSON
from free text and **warn‑and‑skip on failure** — silent scenario loss;
**(c)** the learning loop is **open on the design side**: the implementer reads
`.agents/` guidance but the Test Architect never does, so learned rules never
improve future designs; **(d)** structure is healthy overall (no reorganization
needed), but orchestration/governance logic is duplicated across the CLI verbs.

## ✅ M23 — Golden eval set + design regression harness (done)

> **Delivered.** `eval/cases/` holds real golden packs; a pack's optional
> `<name>.reference.json` carries the **human‑written** test list, and the
> harness measures the design's **semantic recall** against it
> (`src/eval/referenceMatch.ts`: deterministic token matching — stemming,
> corpus stopwords, blended containment/Dice, greedy 1:1 — tuned on the real
> MPORTAL‑2073 pair). `runEval` gates on `--min-recall` (default 60%) alongside
> the structural gate/floor; the report lists the **missed reference cases**
> per design. Wired into `.github/workflows/ci.yml` as the release gate (no LLM needed).
> First golden case: MPORTAL‑2073 (18‑row QA table; incremental‑run pack pins
> at 72% recall — see the reference file's notes). Extra scenarios beyond the
> reference are reported, never penalized.

### Original spec (for reference)

**Why first:** every other accuracy refinement is guesswork until outcomes are
measured. We already have perfect raw material: live runs where a human QA also
wrote the tests (e.g. MPORTAL‑2073's 18‑row QA scenario table vs the agent's
28‑scenario design).

- **M23a — Curate golden cases.** Commit an `eval/cases/` set built from real
  tickets: the ContextPack input + the human‑written reference test list +
  the agent's TestDesignPack. Start with 5–10 tickets across MPORTAL/FINT.
- **M23b — Semantic recall/precision scoring.** Extend `scoreTestDesign` with
  an outcome dimension: given the human reference list, what fraction did the
  design cover (LLM‑judge semantic match), and how many designed scenarios are
  noise? Report recall/precision alongside the structural score.
- **M23c — Wire into CI.** `manso eval --cases eval/cases` as a release
  gate in `.github/workflows/ci.yml`, plus a variance run (same case, N seeds) so
  regressions and flakiness are attributable.

## ✅ M24 — Schema-constrained design passes (structured outputs) (done)

> **Delivered.** All five design passes (AC extraction, Gherkin authoring,
> plain‑English authoring, derived requirements, critique) now run through
> `generateStructured` (`src/integrations/llm/structured.ts`):
> - The pass's Zod contract is converted with `z.toJSONSchema` (Zod v4) and
>   sent as **OpenAI `response_format: json_schema`** (Chat Completions +
>   Responses) or **Anthropic forced tool‑use** (the tool input IS the result).
>   Array‑rooted contracts are advertised inside an object **envelope** and
>   accepted back in either shape. Deployments that reject structured outputs
>   are detected and fall back to plain text for the rest of the process.
> - A parse/schema failure triggers **one corrective re‑prompt carrying the
>   exact validation issues** before the pass gives up — no more silent
>   scenario loss on the first malformed response. Transport errors are not
>   re‑prompted (the SDKs already retry those).
> - **Parse‑failure stats** (calls / retried / failed) are counted per process
>   and reported by `design-tests` (M24c), so the M23 eval can prove the gain.

### Original spec (for reference)

All design passes (AC extraction, authoring, derived requirements, critique,
coverage retry) call `generateText` and `parseJsonObject` on free text; a parse
or schema failure warns and skips — i.e. silently drops scenarios.

- **M24a** — Use native structured outputs where the provider supports it
  (OpenAI `response_format: json_schema`; Anthropic forced tool‑use), derived
  from the existing Zod schemas. Keep free‑text parsing as the fallback.
- **M24b** — One bounded **re‑prompt with the validation error** before
  skipping, so a malformed pass gets a second chance instead of losing output.
- **M24c** — Track parse‑failure rate in telemetry so M23 can prove the gain.

## ✅ M25 — Close the learning loop into design (done; M25b stretch open)

> **Delivered (M25a).** Implementation revealed the gap was wider than
> evaluated: `.agents/guidelines/*.md` — the very directory the learning
> engine writes — was read by **neither** design **nor** implementation. A new
> shared loader (`src/context/repoGuidance.ts`) now reads `AGENTS.md`, the
> `.agents/` docs, **and `guidelines/*.md`** (bounded: per‑file clip + total
> budget, warnings on truncation), and feeds them to **both** sides:
> - **Design:** all three authoring prompts (Gherkin, plain‑English, critique)
>   gain a "Team conventions & learned rules" section via the shared
>   user‑prompt assembly; loaded whenever a repo is resolved (`--repo` or
>   dev‑section).
> - **Implementation:** the implementer's private loader was replaced with the
>   shared one, so merged guidelines now reach the code agent too.
>
> **Still open — M25b (stretch):** Xray‑diff learning — periodically diff what
> the agent uploaded vs what humans later edited/renamed/deleted in Xray; mine
> the deltas into learning candidates (proposed via PR, as today).

### Original spec (for reference)

The learning engine proposes guideline PRs and the implementer consumes
`.agents/` guidance — but the **Test Architect ignores it**. Learned rules
("always add a boundary test for pagination", team phrasing conventions)
never reach future designs.

- **M25a** — Load `.agents/guidelines/*.md` (+ design‑relevant learnings) into
  the design prompt, bounded, the same way the implementer does.
- **M25b — Xray‑diff learning (stretch).** Periodically diff what the agent
  uploaded vs what humans later edited/renamed/deleted in Xray; mine the
  deltas into learning candidates (proposed via PR, as today).

## ✅ M26 — Design revision mode (update, don't append) (done)

> **Delivered.** A re‑run now revises the ticket's test set instead of
> appending near‑duplicates:
> - The sink lists the story's linked Test issues (key + summary) and
>   **semantically compares** the fresh design against them, reusing M23's
>   matcher at a deliberately high threshold (**0.75**) — a wrong skip silently
>   loses a needed test, a wrong create is a visible duplicate a human merges.
> - Matched → **kept** (skipped, recording the matched key + similarity);
>   unmatched design scenario → **added**; a linked test **Manso created**
>   (identified by the `manso` label) that the latest design no longer
>   covers → **retire candidate**.
> - Retire candidates are posted as a **Jira comment** (added / possibly
>   obsolete) — **never auto‑deleted**. Hand‑written tests are never proposed:
>   if the label lookup fails, no candidates are reported at all.
> - `XrayApplication.revision` carries the delta; `design-tests` prints it.
> This subsumes the deferred semantic‑dedup item.

### Original spec (for reference)

Re‑running design on a changed ticket should produce a **delta**, not a second
batch. Reconstruct the existing linked tests (the `--issue` fetch machinery),
semantically compare them against the fresh design (this subsumes the deferred
semantic‑dedup item), and propose **add / update / retire** — posted as a Jira
comment for review; only genuinely new tests are created.

## 🗺️ M27 — Test maintenance loop (authoring → lifecycle ownership)

The next level for the product: stop at nothing after the PR. Consume Xray
test‑execution results / CI failures for manso‑authored tests, triage with
the existing learning classifier (flaky vs systemic vs app‑changed), open
**heal PRs** automatically for broken automation (healer + respond‑to‑pr
machinery already exist), and flag obsolete tests for retirement.

## 🗺️ M28 — Workflow-layer extraction (pure refactor)

No reorganization needed — module boundaries are healthy (largest file 816
lines). Targeted extraction only:

- Move orchestration out of the CLI verbs into `src/workflows/` (design,
  implement); a shared `withGovernance()` policy wrapper owns the
  meter‑ledger‑budget‑audit sequence that is currently copy‑pasted between
  `designTests.ts` and `implementTests.ts`.
- Unify the three overlapping token‑usage shapes (`UsageDelta`,
  `LlmUsageTotals`, `EstimableUsage`) into one.
- Behavior‑preserving, gated by the existing 426 tests.

---

## ✅ M22 — Requirement coverage beyond acceptance criteria (risk- & edge-aware design) (done)

> **Delivered.** The Test Architect now runs two extra passes around design and
> a second coverage gate, all config-gated:
> - **Derived-requirement extraction** (`extractDerivedRequirements`) mines the
>   full context for implied behaviours the ACs don't state → `DerivedRequirement[]`
>   (`{id, text, category, risk, sourceEvidence}`) on the pack. Resilient: warns
>   and yields `[]` on failure.
> - **Scenarios carry `polarity`** (`positive`/`negative`/`boundary`) and `drIds`
>   as structured fields; the design prompts ask for them and to cover each
>   derived requirement, with a negative/boundary scenario for high-risk targets.
> - **Risk/edge coverage gate** (`auditRiskCoverage` + `buildRiskCoverage`): a
>   high-risk AC or derived requirement is unsatisfied unless it has a
>   negative-or-boundary scenario, and an uncovered derived requirement is a gap.
>   `policy.gates.riskCoverage` = `required | warn | off` (**default `warn`** — it
>   surfaces gaps in `riskCoverageMatrix` + warnings without blocking).
> - **Adversarial critique** (`critiqueDesign`) — one bounded "what did we miss?"
>   pass that folds in genuinely-missing scenarios (no duplicates) and records the
>   rest as gaps/open questions. Resilient.
> Config: `policy.gates.riskCoverage`, `policy.design.deriveRequirements`,
> `policy.design.adversarialCritique` (both default `true`). Modules under
> `src/agents/testArchitect/` (`derivedRequirements.ts`, `critique.ts`) +
> `coverageAuditor`. Renderer surfaces derived requirements + the risk/edge table.

### Original spec (for reference)

> Today the test design is *anchored*
> on the acceptance criteria extracted from the ticket, and the coverage gate
> only enforces "every stated AC is covered by ≥ 1 scenario." That makes the AC
> set both the backbone and the **ceiling of what is guaranteed** — the gate is
> blind to everything the requirement *implies* but nobody wrote down as an AC
> (error handling, boundaries, concurrency, security, data variations). The
> prompt already *asks* for those, but nothing *measures* them, so exploratory
> coverage depends on the model's diligence on a given run rather than on a
> checkable invariant. M22 turns "understand the whole requirement, then test it"
> into an enforced property, not a hope.

### Why
On a 5-AC story the engine can (and often does) produce far more than 5
scenarios — `acCoverageMatrix` is many-to-many and the gate is a floor, not a
cap. But the *only* guarantee is AC coverage. A thin design that satisfies the
five ACs and skips the obvious negative/boundary cases still **passes the gate**.
The failure mode isn't "exactly five tests" — it's "the safety net catches AC
gaps, not **requirement** gaps." This milestone adds a second coverage dimension
so missed edge/risk behaviour is surfaced and gateable.

### End-to-end flow (additions to the Test Architect)
1. **Derived-requirement extraction (new pass).** After AC extraction, a second
   pass mines the **full ContextPack** (description, comments, linked tickets,
   attachments, evidence graph) for **implied behaviours the ACs do not state** —
   error/failure paths, boundary & data variations, permissions/security,
   concurrency/state, non-functional expectations. Emits a bounded list of
   `DerivedRequirement` items, each tagged with a `category` and a `risk`, and
   carrying `sourceEvidence` (so a reviewer can see *why* it was inferred, and
   reject noise). These are **coverage targets**, not ACs — kept distinct so the
   contract with the product team (the literal ACs) stays honest.
2. **Design as today, but over ACs + derived requirements.** The author covers
   both sets; the existing happy/negative/edge/security guidance stays.
3. **Two-dimensional coverage gate.** Extend the Coverage Auditor:
   - **AC coverage** (unchanged, the floor) — every AC id → ≥ 1 scenario.
   - **Risk/edge coverage** (new) — each high-risk AC or derived requirement
     should have at least one **negative or boundary** scenario, not only a
     happy-path one. Configurable strictness like the AC gate
     (`required | warn | off`). Falls back to `warn` so it never hard-blocks a
     pipeline by surprise.
4. **Adversarial critique pass (bounded, optional).** Before upload, a single
   "what did this design miss?" review pass over (context + ACs + derived
   requirements + drafted scenarios) proposes gaps; high-confidence, evidence-
   backed gaps are folded back in (one bounded retry, reusing the existing
   gap-retry machinery), the rest are written to `coverageGaps` / `openQuestions`
   so they are visible rather than silent.

### Artifacts & schema additions
- `ContextPack` (or `TestDesignPack`) gains `derivedRequirements: DerivedRequirement[]`
  — `{ id: "DR-n", text, category, risk, sourceEvidence[] }` — persisted in
  `context.json` / the design pack so the inference is inspectable and auditable.
- `acCoverageMatrix` is complemented by a `riskCoverage` summary (which
  AC/DR ids have negative-or-boundary coverage vs only happy-path).
- The design markdown/`strategySummary` surfaces the derived requirements and the
  risk-coverage result distinctly from the ACs.

### Config additions (`policy.gates`)
```jsonc
{
  "gates": {
    "acCoverage": "required",        // existing floor (unchanged)
    "riskCoverage": "warn",          // new: required | warn | off (default warn)
    "deriveRequirements": true,      // run the derived-requirement pass
    "adversarialCritique": true      // run the bounded "what did we miss?" pass
  }
}
```

### Sub-slices
- **M22a — Derived-requirement extraction.** New design pass + `DerivedRequirement`
  schema; bounded, evidence-backed, testable with a stub LLM. Pure addition —
  with the gate left `off` it changes nothing observable.
- **M22b — Risk/edge coverage gate.** Extend the Coverage Auditor with the second
  dimension + `riskCoverage` config; surface results in the design output.
- **M22c — Adversarial critique pass.** One bounded review pass, reusing the
  existing gap-retry loop; folds back high-confidence gaps, records the rest.
- **M22d — Grounded inference (stretch, pairs with M20).** When an environment is
  available, let exploration observations feed the derived-requirement pass so
  inferred edge cases are grounded in the real app, not only the written ticket.

### Risks & guardrails
- **Over-generation / noise.** Derived requirements are inference, not fact —
  hence they are kept *separate* from ACs, must carry `sourceEvidence`, and are
  bounded in count; the critique pass is capped at one retry to bound LLM cost.
- **Don't break pipelines.** The new gate defaults to `warn`, never `required`,
  so existing unattended runs keep passing until a team opts in.
- **Honesty of the AC contract.** ACs remain the literal agreement with product;
  derived requirements are clearly labelled as agent-inferred coverage targets.
- **Cost.** Two extra LLM passes — gated by the `deriveRequirements` /
  `adversarialCritique` knobs and the existing budget enforcement (M15).

---

## ✅ M20 — Environment-aware, explore-before-implement (done)

> **Delivered.** When a stack configures a `setupCommand` (e.g. `docker compose
> up -d`), `implement-tests` brings the app up once, **explores it** (Playwright
> MCP for real UI locators, or OpenAPI for API endpoints) to ground the tests,
> implements with that brief, verifies against the live env, and tears it down.
> If Docker/the env is unavailable it **falls back to today's behaviour** and
> still raises the PR — nothing blocks. Modules: `src/agents/environment/`
> (lifecycle + readiness wait), `src/agents/explorer/` (UI/API briefs), wired
> through `runImplementTests` (gated on `stack.setupCommand`, `--no-env` to skip).
> The brief is persisted to `out/<KEY>/exploration.md`. Stack config gained
> `kind`, `setupCommand`, `teardownCommand`, `appUrl`, `healthCheck`, `openApiUrl`.

### Original spec (for reference)

> **The highest-leverage quality milestone.** Today the implementation agent
> writes test code by *guessing* — it invents DOM locators it has never seen and
> assumes API endpoints. M20 makes it **spin up the real app, explore it, and
> ground the tests in reality** before writing a line of code, then run and
> verify against that running environment.

### Why
On FINT-1056 the agent produced locators like `revealColumnHeader('Status')`
with no knowledge of the actual DOM, and verify went red. Real, passing tests
require the agent to *see* the running app (UI) or its API contract (Swagger)
first. This milestone turns "plausible-looking tests" into "tests that pass
against the real system."

### End-to-end flow (env-aware Implementer)
1. **Setup (once per run).** Run `stack.setupCommand` (e.g. `docker compose up`
   / `npm run docker:ui:stack`), then wait for readiness via `stack.appUrl` /
   `stack.healthCheck`. Running setup **once around the whole run** (not inside
   each verify/heal cycle) also fixes the Docker heal-loop cost problem.
2. **Explore (modality-specific) → an "exploration brief"** fed into the
   implement prompt:
   - **UI stacks** — drive the **live app** with the **Playwright MCP server**
     (already wired) or the Playwright CLI: walk each scenario's flow, capture
     **real DOM locators** (role / label / `data-testid`), actual visible text,
     and observed states. Emits a per-scenario locator + flow brief so the agent
     stops inventing selectors.
   - **API stacks** — fetch the **OpenAPI/Swagger** definition (from
     `stack.openApiUrl` or a repo path), extract the endpoints, methods, and
     request/response schemas relevant to the acceptance criteria. Emits an
     endpoint + schema brief.
3. **Implement.** The code agent writes step definitions / page objects /
   controller clients **grounded in the brief** (real locators, real endpoints)
   and reuses the repository's existing steps.
4. **Verify.** Run the scoped tests **against the already-running env**; the heal
   loop now reacts to *real* failures, not environment errors.
5. **Teardown (once).** Run `stack.teardownCommand` (e.g. `docker compose down`).

### Config additions (`.agents/manso.config.json` → `stacks[]`)
```jsonc
{
  "id": "playwright-bdd-ts",
  "kind": "ui",                       // "ui" | "api" — selects exploration mode
  "root": ".",
  "verifyCommand": "npm run test:ui:feature -- @<tag>",
  "setupCommand": "npm run docker:ui:stack:up",   // run once; brings env up
  "teardownCommand": "npm run docker:ui:stack:down",
  "appUrl": "http://localhost:8080",  // UI: health/ready wait + MCP target
  "healthCheck": "http://localhost:8080/health",
  "openApiUrl": "http://localhost:8080/swagger/v1/swagger.json"  // API stacks
}
```
Modality is resolved from `stack.kind` and/or the `@ui` / `@api` scenario tags.

### Sub-slices
- **M20a — Env lifecycle.** `setupCommand` / `teardownCommand` + readiness wait,
  run **once** around implement+verify. Pure orchestration; bounded and testable
  with a stub command runner. (Also stands alone as the Docker fix.)
- **M20b — UI exploration.** Playwright MCP/CLI exploration → locator/flow brief
  injected into the implement prompt. Builds on the existing
  `playwright-mcp-exploration` + `selector-strategy` skills and the configured
  Playwright MCP server.
- **M20c — API exploration.** OpenAPI/Swagger fetch + parse → endpoint/schema
  brief. Reuse existing client/schema conventions from the repo.
- **M20d — Modality detection** from `stack.kind` + scenario tags to route UI vs
  API exploration.

### Artifacts
Persist the exploration brief to `out/<KEY>/exploration.md` (provenance + what
the agent actually observed), so a reviewer can see what grounded the tests.

### Risks & guardrails
- **Docker availability** — local Docker Desktop; in CI a Docker-capable agent,
  or docker-in-docker, or pipeline service containers.
- **Sandbox profile** — exploration + Docker need exec + network, so
  `MANSO_SANDBOX=danger-full-access` (or run the agent inside a container);
  `read-only` / `workspace-write` would block it.
- **Ports & teardown** — ensure free ports and reliable teardown (`down`) even
  on failure, to avoid leaked containers.
- **MCP non-determinism** — bound exploration with step/time budgets.
- **Secrets posture unchanged** — env creds come from `.env` / variable groups.

---

## ✅ M15 — Budget enforcement wiring (done)
`implement-tests` now refuses to start when today's recorded spend already
exceeds `policy.budgets.maxCostPerDayUsd` (per-day cost ledger at
`<out>/cost-ledger.jsonl`), records each run's measured agent cost, and warns +
emits a `budget.breached` audit entry on a run/day cap breach. (Design-phase
text-LLM cost isn't metered yet — the text clients don't surface token usage;
that's a follow-up.)

## ✅ M16 — Audit emission wiring (done)
`appendAuditEntry` is now emitted at the consequential actions —
`run.started`/`run.completed`, `design.created`, `xray.uploaded`, `pr.raised`,
`pr.fix-applied`, `rule.proposed`, `budget.breached` — across design-tests,
implement-tests, and respond-to-pr (fire-and-forget, redacted). New
`manso audit` reader command lists + summarises the log.

## ✅ M21 — Wire `policy.gates.humanReviewBeforeUpload` (done)
`design-tests` now reads the gate from the `--repo`'s `.agents` config:
- `true` (default) → uploading to Xray requires `--yes` (safe default).
- `false` → upload proceeds automatically when Xray creds + a design exist (no
  `--yes`), unless `--dry-run` — the lever for unattended/pipeline runs.

Implemented via the exported `xrayUploadConfirmed` predicate + `loadContextPolicy`.

## ✅ M19 — Xray Manual-test upload (plain-english) (done)
Plain-english scenarios now upload to Xray as **Manual** tests via the Xray
GraphQL `createTest` (testType `"Manual"`, `steps[]`), with each scenario step's
`action` + `expectedResult` mapped to a manual step's `action` + `result`. They
are linked to the story exactly like Cucumber tests (same link-type resolution,
idempotency, and project-mandatory-field handling). The output mode is selected
by `testDesign.outputMode` — **`gherkin` (Cucumber) is always the default**;
set `plain-english` to author Manual tests instead. The `hybrid` mode was
removed: a pack is one mode or the other. Modules: `applyTestDesignToXray`
(`createManualTest`) in `src/integrations/xray/testDesignSink.ts`.

## 🗺️ Devcontainer / Dagger sandbox
Execute the code agent inside an isolated container mapped to the existing
sandbox profiles (the profile seam exists; container execution does not).
Pairs naturally with M20's Docker lifecycle.

## 🗺️ More stacks
Add Cypress and others — each is one binding skill + one verify config + one
eval repo.
