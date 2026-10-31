# Changelog

Notable changes, newest first. Commit hashes are on the `agent-manso` repo.

## 2026‑08‑19 — fix(ci): clone-step token preflight (GitHub target repos)

Live failure (builds 780892/781006, DATAEX‑629 → the private GitHub repo
`Manso-Tech-Innovation/rty-health-monitor`): the clone died with git's
cryptic `could not read Username for 'https://github.com'` (exit 128) because
the `GITHUB_TOKEN` in `manso-secrets` is not valid for that repo.

- Both runner YMLs now **preflight the credential** before cloning: an
  empty/unexpanded token, or a token GitHub rejects (`git ls-remote` probe),
  fails the step with an exact, actionable message (expired PAT / missing repo
  access / org SSO not authorized) instead of a bare 128.
- Same guard for the Azure DevOps PAT branch.

## 2026‑07‑03 — M26: design revision mode (update, don't append)

Re‑running design on a ticket now **revises** its test set instead of piling on
near‑duplicates:

- The Xray sink lists the story's linked Test issues and **semantically
  compares** the fresh design against them (M23's matcher, threshold 0.75 —
  high on purpose: a wrong skip loses a test, a wrong create is a visible
  duplicate). Matches are **kept** (skipped, recording the matched key +
  similarity); everything else is created as before.
- Linked tests **Manso created** (by the `manso` label) that the latest
  design no longer covers are reported as **retire candidates** in a Jira
  comment — never auto‑deleted. Hand‑written tests are never proposed; if the
  label lookup fails, no candidates are reported.
- `XrayApplication.revision` carries the delta (kept + retireCandidates) and
  `design-tests` prints it.

## 2026‑07‑03 — fix: reporter rejection must not sink the Xray upload

Live failure (build 752394, MPORTAL‑2074): the design succeeded but **all 14**
Xray creates failed with `reporter: Field 'reporter' cannot be set` — the
integration account lacks *Modify Reporter* in MPORTAL — and the pipeline
stayed green with only a warning **count** in the log.

- **Sink resilience:** on a reporter rejection the sink now warns loudly, drops
  the `reporter` field **for the rest of the run**, and retries — tests get
  created without attribution instead of not at all.
- **Loud diagnostics:** `design-tests` now prints each sink failure's message
  next to `[failed] <title>` and every application warning (deduped) — no more
  artifact download to learn why.
- **No silent no‑ops:** when the sink was enabled and **every** create failed,
  `design-tests` exits non‑zero so the pipeline shows red.

## 2026‑07‑02 — M25: the learning loop reaches design (and implementation)

Implementation surfaced a wider gap than evaluated: `.agents/guidelines/*.md`
— the directory the learning engine proposes rules into — was read by
**neither** design **nor** implementation. Now:

- **Shared guidance loader** (`src/context/repoGuidance.ts`): `AGENTS.md`, the
  `.agents/` docs, and `.agents/guidelines/*.md` (sorted), bounded — per‑file
  clip + total budget with explicit warnings, no silent truncation.
- **Design side:** the Gherkin, plain‑English, and critique prompts gain a
  "Team conventions & learned rules" section (one shared assembly point);
  loaded whenever a repo is resolved.
- **Implementer side:** its private loader was replaced with the shared one,
  so merged guidelines finally reach the code agent too.
- M25b (Xray‑diff learning — mine human edits to agent tests into learning
  candidates) remains open as a stretch item.

## 2026‑07‑02 — M24: schema-constrained design passes (structured outputs)

A malformed LLM response no longer silently drops scenarios:

- **`generateStructured`** (`src/integrations/llm/structured.ts`) now backs all
  five design passes: the pass's Zod contract → JSON Schema (`z.toJSONSchema`)
  → **OpenAI `response_format: json_schema`** (Chat Completions + Responses) or
  **Anthropic forced tool‑use**. Array‑rooted contracts travel in an object
  envelope (accepted back in either shape); deployments that reject structured
  outputs are detected per client and fall back to plain text for the rest of
  the process.
- **One corrective re‑prompt** carrying the exact validation issues before a
  pass gives up (transport errors are not re‑prompted — the SDKs retry those).
- **Pass‑health stats** (calls / retried / failed) reported by `design-tests`,
  so the parse‑failure rate is visible and the M23 eval can prove the gain.

## 2026‑07‑02 — M23: golden eval set + design regression harness

Outcome accuracy is now **measured, not assumed**:

- **Golden cases** (`eval/cases/`) from real runs; a pack's optional
  `<name>.reference.json` carries the **human‑written** test list for the same
  ticket. First case: MPORTAL‑2073 — the QA engineer's 18‑row scenario table vs
  the agent's design.
- **Semantic recall scoring** (`src/eval/referenceMatch.ts`): deterministic
  token matching (light stemming, dynamic corpus stopwords, blended
  containment/Dice similarity, greedy 1:1), tuned on the real MPORTAL‑2073
  pair. The eval report shows recall per case and lists the **missed reference
  cases** — the actionable output. Scenarios beyond the reference are reported,
  never penalized.
- **Recall release gate**: `runEval`/`manso eval` gain `--min-recall`
  (default 60%, applied only to reference‑carrying cases); the eval step is
  wired into `pipelines/build-image.yml` — deterministic, no LLM/creds in CI.

## 2026‑06‑05 — Evaluation P3 fixes

- **`run.yml` parity (P3‑9)** — the ACR/container runner now matches
  `run-hosted.yml`: optional `targetRepo` (conditional clone + git identity),
  `testFields`/`reporter`/M22 parameters, the Langfuse egress check,
  `--require-linked-tests` on implement, `IMPLEMENTATION_LLM_BASE_URL`
  mapping, and the cost ledger published with the artifact.
- **Per‑QA attribution (P3‑11)** — new `--reporter <accountId>` flag on
  `design-tests`/`analyse-coverage` + a `reporter` pipeline parameter: a Jira
  rule passes `{{initiator.accountId}}` and created Test issues are reported
  by the triggering QA (needs the project's *Modify Reporter* permission).
  The dedicated `Manso` service account remains the recommended
  Creator‑level fix.
- **Codex/Azure misconfiguration is loud (P3‑10)** — startup warning when the
  Codex base URL is a `*.services.ai.azure.com` host (its `/responses`
  WebSocket replies 302; use `https://<name>.openai.azure.com/openai/v1`).
  The Windows crash remains an upstream Codex‑SDK limitation.
- **M20‑on‑CI requirements documented (P3‑8)** — PIPELINE.md now lists what a
  target stack needs for a real env‑aware run (hermetic compose, published
  ports, secrets, `readinessTimeoutMs`, Docker‑capable runner) and how to
  verify one happened (`exploration.md` in the artifact).
- Both runner YMLs also map `MANSO_COST_LEDGER` (ledger lands in the
  `manso-out` artifact) and `MANSO_MODEL_PRICES` (optional price
  overrides; unexpanded `$(…)` macros are ignored safely).

## 2026‑06‑05 — Evaluation P1/P2 fixes

Driven by [EVALUATION.md](./EVALUATION.md); see its P1/P2 tables for detail.

- **No more silent implement no‑ops** — loud warning when `--issue` finds zero
  linked tests, plus `--require-linked-tests` (wired into the pipeline implement
  step) to fail instead. (The FINT‑1056 "0 links" itself was root‑caused as a
  point‑in‑time truth, not a code bug.)
- **Verified work survives an agent crash** — agent exit≠0 with green verify and
  changed files is rescued to `partial` (commit/PR proceed, warning attached)
  instead of reporting `failed` and turning the pipeline red.
- **Duplicate‑test defence** — `normalizeTestTitle` (case/punctuation/unicode‑
  insensitive) backs the Xray sink idempotency check, a new within‑run dedup,
  the critique pass, and the `--issue` repo diff.
- **`respond-to-pr` traced** — fix‑agent runs now create a Langfuse session with
  usage/cost, like implement/heal.
- **Cost metering everywhere** — new model **price table**
  (`src/policy/modelPrices.ts`, override via `MANSO_MODEL_PRICES`) with a
  cache‑aware estimator: the budget ledger now sees **Codex** runs and the
  **design phase** (text clients accumulate token usage; `design-tests` records
  estimated spend, warns + audits on budget breach). The Langfuse agent span
  emits cached/reasoning token details and an exact‑or‑estimated
  `cost_details` — fixing the ~4× Codex over‑count.
- **M22 defaults unified** — derived requirements + adversarial critique ON and
  the risk/edge gate `warn` by default for **every** design run (repo or
  repo‑less); repo config or flags can disable.

## 2026‑06‑04 — Coverage quality, observability, and pipeline ergonomics

A focused cycle hardening the design output and the unattended (pipeline) path,
driven by evaluating real runs on `MPORTAL‑2073`.

### Test‑design quality

- **M19 — Xray Manual‑test upload.** Plain‑english scenarios now upload to Xray
  as **Manual** tests (`testType "Manual"`, `steps[]` from action/expected),
  linked exactly like Cucumber tests. The **`hybrid`** output mode was removed —
  a pack is `gherkin` (Cucumber, default) **or** `plain-english` (Manual).
  (`bdb4e14`)
- **M22 — Requirement coverage beyond the ACs.** Three additions so coverage is
  *measured*, not hoped for (`3838b60`):
  - **Derived‑requirement extraction** — mines the full context for implied
    behaviours the ACs don't state (error/boundary/security/data/state) →
    `derivedRequirements[]`.
  - **Risk/edge coverage gate** — every high‑risk AC/derived requirement must
    have a `negative` or `boundary` scenario; scenarios carry structured
    `polarity` + `drIds`. `policy.gates.riskCoverage` = `required|warn|off`
    (default `warn`).
  - **Adversarial critique** — a bounded "what did this design miss?" pass that
    folds in genuinely‑missing scenarios.
  - **Repo‑less control (`edaf0bf`):** `--derive-requirements`,
    `--adversarial-critique`, `--risk-coverage` CLI flags + matching pipeline
    parameters, so a Jira rule (no `targetRepo`) can turn M22 on/off per run.
    Flags override the repo's `.agents` config.

### Context fidelity (why a run can miss scenarios)

- **Comments are no longer clipped at 800 chars** (`53a93f6`). A ticket's
  richest spec is often a comment — a QA scenario table, dev clarifications.
  Per‑comment cap raised **800 → 8000**, with a 24,000‑char total budget so a
  long table survives without unbounded prompt growth. (On `MPORTAL‑2073` an
  18‑row QA scenario table was being cut after ~row 2.)
- **Image attachments are actually analysed now** (`35fd6fa`). The attachment
  download sent `Accept: application/octet-stream`; Jira's content endpoint
  serves the file's real type (`image/png`) and **406'd**, so vision silently
  never ran. Changed to `Accept: */*` — Figma screenshots now come back with
  `analysisSource: "vision"`.

### Environment‑aware implementation (M20)

- **M20 shipped** (`1a0aaf8`): when a stack configures a `setupCommand` (Docker),
  the implement run brings the app up once, **explores it** (Playwright MCP for
  real UI locators, or OpenAPI for API endpoints), implements against it, and
  tears it down. No Docker → graceful fallback (PR still raised). `--no-env` skips.
- **Configurable readiness timeout** (`9a209b2`): `stack.readinessTimeoutMs`
  (default 120000) — for apps that boot slowly (e.g. an Nx serve, ~8 min).

### Observability (Langfuse)

- **Agent usage + cost now reach Langfuse** (`738d9dd`, `b7181b3`). The
  implement/heal agent run was bypassing the traced wrapper, so implement runs
  produced **no Langfuse session**. Now routed through `runImplementationAgent`
  with telemetry; the span is emitted as a **generation** with token usage and
  cost (Claude: exact `total_cost_usd`; Codex: priced from the model). design
  was already traced.
- **Pipeline egress diagnostic** (`601560c`): a non‑fatal step prints the HTTP
  status of `OTEL_ENDPOINT/api/public/health`, so a blocked egress shows up
  instead of manifesting as a silent "no session".
- **Note:** design‑phase cost needs the design model priced in **Langfuse →
  Models** (e.g. `gpt-5.3-chat`, `gpt-5.3-codex`); Langfuse routes by the
  public/secret key pair, not `OTEL_PROJECT_NAME`.

### Pipeline / automation ergonomics

- **`targetRepo` is now optional** for `design`/`coverage` (`511f1e6`). A rule
  with no `targetRepo` runs **issue‑only** (no repo step‑reuse / `.agents`
  config) instead of failing; `implement`/`both` fail fast with a clear message
  (they must write code somewhere).
- **`--test-fields` / `testFields`** (`ed9bdc3`): supply project‑mandatory Jira
  fields on created Test issues (e.g. a Tempo Account customfield) from the CLI
  or the Jira rule body, merged over the repo's `xray.testFields` (flag wins).
  Fixes the repo‑less "field is required" failure.
- **Docker image builds again** (`a35761c`): `PLAYWRIGHT_VERSION` ARG moved
  before the first `FROM` (was empty → `v-jammy: not found`); dropped the
  `apt-get install git` step (git is already in the Playwright base, and apt
  failed behind a corporate proxy).

### Earlier in the cycle (2026‑06‑02)

- **`analyse-coverage`** command + `coverage` pipeline mode — assess linked tests
  vs the story, comment the gap analysis, create the missing tests, reusing
  existing step phrasings. (`df07517`, `d0a2c02`)
- **Project‑mandatory fields on test creation** — inherit primitive required
  fields from the story; override structured ones via `xray.testFields`.
  (`9496ce0`, `289a114`)
- **Host‑aware target repos** — pipeline clones/pushes/PRs against both Azure
  DevOps and GitHub. (`da045d8`)
- **`wiki/`** — an HTML feature‑documentation site. (`22ffc44`)
