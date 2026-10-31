# Manso — Feature Matrix

*A capability-by-capability view of the Manso AI testing agent, for QA leads
evaluating what it does today, where humans stay in control, and what is coming.*

**Status legend:**
✅ **Live** — in production use via the pipeline · 🔌 **Built** — implemented & tested, needs a live environment or one-time setup to exercise · 🚧 **In progress** · 🗺️ **Planned**

**In one sentence:** point Manso at a Jira story and it researches the ticket,
designs the test cases a QA would write, uploads them to Xray linked to the story,
implements the automation code against a running app, and raises a pull request —
learning from review feedback as it goes.

---

## 1. Triggering & operation

| Feature | What it does | Status | Human in the loop? |
|---|---|---|---|
| Jira automation trigger | A Jira rule (e.g. on transition to *Ready for Test*) calls one parameterized Azure pipeline — no manual kickoff | ✅ | Rule fires on your workflow step |
| Run modes | `design` (test cases only), `implement` (automation only), `both`, `coverage` (gap analysis) | ✅ | Chosen per rule |
| Repo-less design | `design`/`coverage` run with no target repo at all (issue-only) | ✅ | — |
| Per-project fields | Rule body supplies project-mandatory Jira fields (e.g. Tempo Account) and per-QA attribution — no code change per project | ✅ | Configured once per rule |
| Local CLI | Every capability also runs from a developer CLI (`manso design-tests --issue KEY …`) with `--dry-run` everywhere | ✅ | Full control |
| Docker image | Containerized runner (Playwright base) published to GHCR for GitHub/Azure pipelines | ✅ | — |

## 2. Understanding the ticket (context)

| Feature | What it does | Status | Notes |
|---|---|---|---|
| Full ticket ingestion | Description, **all comments**, attachments, issue links, dev branches/PRs, linked Confluence pages | ✅ | Long QA comment tables are kept, not clipped |
| Rich-text fidelity | Jira's ADF converted to structure-preserving Markdown — tables, panels, code blocks survive | ✅ | ACs hidden in tables aren't lost |
| Screenshot / mockup vision | Image attachments are analysed by a vision model and cited as evidence | ✅ | Verified live on Figma screenshots |
| Linked-ticket expansion | Epic, subtasks, related stories pulled in (bounded, with warnings when capped) | ✅ | |
| Evidence graph | Typed traceability graph: requirement ↔ comment ↔ page ↔ test ↔ PR | ✅ | Rendered in the context report |
| Retrieval & deep research | BM25 search over the whole corpus; optional agentic mode where the LLM drives its own retrieval | ✅ / 🔌 | Deep mode is opt-in (`--deep`) |

## 3. Test design

| Feature | What it does | Status | Notes |
|---|---|---|---|
| AC extraction | Atomic acceptance criteria (`AC-n`) extracted from the whole context, each with its source | ✅ | |
| Gherkin or Manual output | Cucumber (Given/When/Then, default) **or** plain-English manual test cases — one switch | ✅ | |
| **Reuses your existing Gherkin steps** | Connects to the test repo, reads existing step phrasings, and authors scenarios that snap onto them — no duplicate step definitions | ✅ | A flagship capability |
| Coverage gate | Every AC must be covered by ≥1 scenario or an existing test — enforced, with one bounded retry | ✅ | `required / warn / off` |
| Beyond-the-ACs coverage (M22) | Mines **derived requirements** (error/boundary/security/data/state), tags scenario polarity, and gates that high-risk items get negative/boundary tests; adversarial "what did we miss?" pass | ✅ | On by default |
| Learned team rules in prompts (M25) | Merged `.agents/guidelines/*.md` rules (from review feedback) shape every future design | ✅ | The learning loop, closed |
| Reliable LLM output (M24) | Design passes are schema-constrained (structured outputs) with one corrective retry — malformed responses can't silently drop scenarios | ✅ | Pass-health stats per run |
| Tag conventions | `@story` key at feature level, functional tags only, `@smoke` derived from risk — enforced automatically | ✅ | |

## 4. Xray & Jira integration

| Feature | What it does | Status | Notes |
|---|---|---|---|
| Test creation | Gherkin → **Cucumber** tests, plain-English → **Manual** tests (real steps), created via Xray GraphQL | ✅ | |
| Story linking | Every test linked as **"is tested by"** on the story (direction resolved per instance) | ✅ | |
| Duplicate protection | Idempotent re-runs: exact, normalized (case/punctuation), *and* semantic title matching | ✅ | |
| **Revision mode (M26)** | A re-run produces a **delta**: keeps what's covered, adds what's new, and reports agent-created tests the design no longer covers as *retire candidates* in a Jira comment | ✅ | Never deletes anything; never flags hand-written tests |
| Project-mandatory fields | Inherits the story's required fields; structured ones (Tempo Account) supplied per rule | ✅ | |
| Attribution | `reporter` (needs *Modify Reporter* / project-admin membership) and `assignee` settable per rule, so tests belong to the project's QA | ✅ | Degrades gracefully if permission is missing |

## 5. Test automation (implementation)

| Feature | What it does | Status | Notes |
|---|---|---|---|
| Code agent | Claude / Codex SDK writes step definitions & page objects per the repo's conventions and binding stack (`playwright-bdd-ts`, `dotnet-reqnroll`) | ✅ | |
| Stateless from Xray | `implement --issue KEY` reconstructs the design from the linked Xray tests — no artifact hand-off between pipeline runs; implements only what's missing in the repo | ✅ | Guards against "design never ran" |
| **Environment-aware runs (M20)** | Spins the app up in Docker, **explores the live UI/API** for real selectors & endpoints, runs the tests against it, self-heals failures, tears down | 🔌 | Built + tested; needs a hermetic compose or self-hosted agent per target repo |
| Verify + heal loop | Failing verify triggers a scoped "repair only the failing tests" pass (bounded attempts) | ✅ | |
| Branch, commit, PR | Branch per story, token-based push (no stored git creds), PR on **Azure DevOps or GitHub** (auto-detected) | ✅ | Nothing is ever auto-merged |
| Crash resilience | If the agent crashes *after* finishing (verify green, files changed), the work is kept and the PR still raised | ✅ | |

## 6. Feedback & learning

| Feature | What it does | Status | Notes |
|---|---|---|---|
| PR conversation | `@manso <ask>` on the PR → the agent fixes, explains, or acknowledges; re-verifies after fixes; loop-safe | ✅ | |
| Knowledge capture | `@update-knowledge <rule>` / `@update-agent <rule>` turn review feedback into guideline edits — **proposed via a separate human-reviewed PR, never silently applied** | ✅ | |
| Closed learning loop | Merged guidelines feed back into both future designs and future code | ✅ | |
| Learning classifier | Distinguishes transient (flaky/infra) from systemic signals; only systemic ones become rule proposals | ✅ | |

## 7. Quality measurement (of Manso itself)

| Feature | What it does | Status | Notes |
|---|---|---|---|
| Golden eval set (M23) | Real tickets where a human QA also wrote tests serve as reference; the design's **semantic recall** against the human list is measured | ✅ | First case: an 18-row QA table, pinned at 72% recall |
| Release gate in CI | Every build scores the golden cases (structure + recall) and **fails on regression** — deterministic, no LLM in CI | ✅ | |
| Unit test suite | 455 tests / 58 files, no-network; type-safe, schema-validated artifacts at every hand-off | ✅ | |

## 8. Governance & safety

| Feature | What it does | Status | Notes |
|---|---|---|---|
| Human control points | Upload confirmation gates, PR review before merge, rule proposals via PR, retire candidates only *suggested* | ✅ | The agent never deletes or merges |
| Cost control | Per-run and per-day budget caps enforced against a cost ledger; all LLM spend metered (incl. cached-token-aware pricing) | ✅ | |
| Audit trail | Append-only, secret-redacted log of every consequential action (`run.started` … `pr.raised` … `budget.breached`) | ✅ | `manso audit` to read |
| Secret hygiene | Tokens never in URLs, logs, or committed config; `${ENV_VAR}` expansion at runtime; secrets in Key-Vault-backed variable groups | ✅ | |
| Loud failure policy | Zero-created uploads, missing linked tests, misconfigured endpoints → red pipelines and explicit messages, never silent no-ops | ✅ | |

## 9. Observability

| Feature | What it does | Status | Notes |
|---|---|---|---|
| Full LLM tracing | Every model call traced to **Langfuse** (or Phoenix), grouped one session per Jira ticket | ✅ | |
| True cost per run | Exact or cache-aware estimated cost on every span and in the CLI summary | ✅ | |
| Run health | Structured-output pass health, coverage gate results, revision deltas — all in the run log | ✅ | |

## 10. Coming next

| Feature | What it adds | Status |
|---|---|---|
| Test maintenance loop (M27) | Read Xray execution history, detect regression clusters ("6 tests broke together on July 9") vs flaky vs never-worked, propose/heal via PR | 🚧 scoping — live Xray data already validated |
| Xray-diff learning (M25b) | Mine the edits QAs make to agent-created tests into new guideline proposals | 🗺️ |
| Dedicated service account | `Manso` Jira identity replacing personal credentials — clean attribution and per-project permissions | 🗺️ org action |
| More stacks | Cypress etc. — each is one binding skill + one verify config | 🗺️ |

---

*Sources: [FEATURES.md](./FEATURES.md) (full technical reference) ·
[ROADMAP.md](./ROADMAP.md) (milestone specs) · [CHANGELOG.md](./CHANGELOG.md).
Status is as of 2026-07-16; "Live" means exercised through the production
pipeline on real Manso tickets (MPORTAL, FINT).*
