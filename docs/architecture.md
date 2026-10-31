# Manso Architecture

Five views of the same system, outside-in:

1. **Feature & technology map** — everything the system does and what it's built on.
2. **System context** — Manso and the external systems it talks to.
3. **End-to-end pipeline** — `design-tests` → `implement-tests` → `respond-to-pr`.
4. **Layered component view** — the source-tree packages and their dependencies.
5. **Multi-agent topology** — sub-agents and the artifacts between them.

These reflect the code through **M14** plus the delivered roadmap items
(budget-enforcement wiring, audit emission, GitHubAdapter, and token-based push
auth for unattended/pipeline runs). For a feature-by-feature reference see
[FEATURES.md](./FEATURES.md).

> **Theme.** Each diagram opens with a `%%{init: …}%%` directive that sets a
> modern palette and curved edges. To restyle, edit that line — e.g. swap
> `"theme":"base"` for `"dark"`, `"neutral"`, or `"forest"`, or add
> `"look":"handDrawn"` (Mermaid ≥11) for a sketch style. Renders the same in VS
> Code (Markdown Preview Mermaid Support), GitHub, and https://mermaid.live.
>
> **Pre-rendered exports** (SVG + 2× PNG) live in
> [diagrams/](./diagrams/README.md) for slides/wiki use.

---

## 1. Feature & technology map

The whole system at a glance — capability areas (what it does), the modules that
implement them, and the technologies underneath.

```mermaid
%%{init: {"theme":"base","themeVariables":{"primaryColor":"#eef2ff","primaryTextColor":"#111827","primaryBorderColor":"#818cf8","lineColor":"#94a3b8","secondaryColor":"#e0f2fe","tertiaryColor":"#f8fafc","clusterBkg":"#f8fafc","clusterBorder":"#e2e8f0","fontFamily":"Segoe UI, Roboto, Helvetica, Arial, sans-serif","fontSize":"14px","edgeLabelBackground":"#ffffff"},"flowchart":{"curve":"basis","htmlLabels":true,"padding":12,"nodeSpacing":50,"rankSpacing":55}}}%%
graph TB
    subgraph CLI["CLI · one binary, verb dispatcher (src/cli)"]
        V1["init"]:::v
        V2["check"]:::v
        V3["design-tests"]:::v
        V4["implement-tests"]:::v
        V5["respond-to-pr"]:::v
        V6["eval"]:::v
        V7["fetch · skills"]:::v
    end

    subgraph Context["Context Layer · src/agents/researcher + src/context + src/shared"]
        CX1["Jira/Confluence ingestion<br/>+ ContextProvider seam"]
        CX2["ADF→Markdown (M10b)<br/>tables/panels/links"]
        CX3["Linked-ticket expansion (M10c)<br/>epic/parent/subtasks"]
        CX4["Evidence graph (M10d)<br/>typed nodes + edges"]
        CX5["Attachment understanding (M10e)<br/>text + vision"]
        CX6["Knowledge index (M10f)<br/>BM25 retrieval + cache"]
        CX7["Tool-using Researcher (M10g)<br/>bounded JSON tool-loop"]
    end

    subgraph Design["Test Design Engine · src/agents/testArchitect + coverageAuditor"]
        D1["AC extraction (M6a)"]
        D2["Gherkin authoring (M6b)<br/>tag conventions"]
        D3["Coverage gate (M7)<br/>bounded retry"]
        D4["Reuse + dedup (M10a)<br/>steps · titles · linked Xray"]
    end

    subgraph Impl["Implementation Engine · src/agents/implementer + verifier + healer"]
        I1["Code agent (M9)<br/>Claude SDK · Codex SDK · Shell"]
        I2["Verify + heal loop (M9b)"]
        I3["Branch · commit · PR (M9c)"]
        I4["MCP tools (M11)<br/>Playwright · Figma"]
    end

    subgraph Loop["Feedback + Learning · src/agents/responder + learningEngine"]
        L1["PR feedback loop (M12)<br/>@manso · intents · loop-safety"]
        L2["Learning engine (M13)<br/>transient vs systemic"]
        L3["Proposer → review PR<br/>(never silent)"]
        L4["@update-knowledge / @update-agent (M13e)"]
    end

    subgraph Gov["Governance + Eval · src/policy + src/eval"]
        G1["Redaction (M14)"]
        G2["Cost budgets (M14)"]
        G3["Audit log (M14)"]
        G4["Eval harness + release gate (M14)"]
        G5["Sandbox profiles (M13d)"]
    end

    subgraph Cross["Cross-cutting"]
        XA["Zod artifacts · src/domain<br/>ContextPack · TestDesignPack ·<br/>ImplementationPack · LearningRecord ·<br/>ReadinessReport · EvalReport"]
        XB["Skills · src/skillLoader + skills/<br/>progressive disclosure, repo overrides"]
        XC["Observability · OTel + OpenInference<br/>→ Phoenix / Langfuse"]
        XD["Config · runtimeConfig (env) +<br/>agentConfig (.agents/*.json)"]
    end

    subgraph Tech["Technology stack"]
        T1["TypeScript · Node ESM (NodeNext, strict)"]
        T2["Zod v4 · Vitest · tsx"]
        T3["Anthropic SDK · Claude Agent SDK<br/>OpenAI SDK · Codex SDK"]
        T4["Jira/Confluence REST+GraphQL · Xray GraphQL<br/>Azure DevOps REST · git CLI"]
        T5["MCP (stdio/http/sse)"]
        T6["OpenTelemetry · Arize Phoenix · Langfuse"]
    end

    CLI --> Context
    CLI --> Design
    CLI --> Impl
    CLI --> Loop
    CLI --> Gov
    Context --> Design
    Design --> Impl
    Impl --> Loop
    Loop --> Gov

    Context -.-> XA
    Design -.-> XA
    Impl -.-> XA
    Loop -.-> XA
    Design -.-> XB
    Impl -.-> XB
    Loop -.-> XB

    classDef v fill:#6366f1,stroke:#4f46e5,color:#ffffff,font-weight:bold;

    style CLI fill:#eef2ff,stroke:#c7d2fe,color:#312e81
    style Context fill:#eff6ff,stroke:#bfdbfe,color:#1e3a8a
    style Design fill:#f0fdf4,stroke:#bbf7d0,color:#14532d
    style Impl fill:#fffbeb,stroke:#fde68a,color:#78350f
    style Loop fill:#fdf4ff,stroke:#f5d0fe,color:#701a75
    style Gov fill:#fef2f2,stroke:#fecaca,color:#7f1d1d
    style Cross fill:#f1f5f9,stroke:#e2e8f0,color:#0f172a
    style Tech fill:#f8fafc,stroke:#e2e8f0,color:#334155
```

---

## 2. System context

Who calls Manso and which external systems it touches.

```mermaid
%%{init: {"theme":"base","themeVariables":{"primaryColor":"#eef2ff","primaryTextColor":"#111827","primaryBorderColor":"#818cf8","lineColor":"#94a3b8","secondaryColor":"#e0f2fe","tertiaryColor":"#f8fafc","clusterBkg":"#f8fafc","clusterBorder":"#e2e8f0","fontFamily":"Segoe UI, Roboto, Helvetica, Arial, sans-serif","fontSize":"14px","edgeLabelBackground":"#ffffff"},"flowchart":{"curve":"basis","htmlLabels":true,"padding":12,"nodeSpacing":50,"rankSpacing":55}}}%%
graph LR
    User["User / CI<br/>$ manso &lt;verb&gt;"]

    subgraph Manso["Manso CLI + library"]
        Core["src/cli + src/agents + src/integrations"]
    end

    Jira[("Jira Cloud<br/>REST v3 + GraphQL dev-info")]
    Confluence[("Confluence Cloud<br/>REST, optional")]
    Xray[("Xray Cloud<br/>GraphQL")]
    AzureDevOps[("VCS host<br/>Azure DevOps / GitHub<br/>Git + REST PRs + threads")]
    LLM[("Design LLM<br/>Anthropic / OpenAI / Azure OpenAI")]
    CodeAgent[("Code-agent SDK<br/>Claude Agent SDK / Codex")]
    MCP[("MCP servers<br/>Playwright · Figma")]
    TargetRepo[("Target repo<br/>filesystem + git")]
    AgentRepo[("Manso repo<br/>MANSO_AGENT_REPO")]
    Telemetry[("OTel backend<br/>Phoenix / Langfuse")]

    User --> Manso
    Manso -->|issue, comments, links, dev info, attachments| Jira
    Manso -->|hydrate linked pages| Confluence
    Manso -->|create Cucumber tests + link| Xray
    Manso -->|token-auth push branch · raise PR · read+post threads| AzureDevOps
    Manso -->|AC + Gherkin + vision + retrieval prompts| LLM
    Manso -->|drive code edits + verify + heal| CodeAgent
    CodeAgent -->|explore live app / read design| MCP
    CodeAgent --> TargetRepo
    Manso --> TargetRepo
    Manso -.->|"@update-agent proposal PR"| AgentRepo
    Manso -.->|spans · tokens · cost| Telemetry
```

**Reads from:** Jira, Confluence, target repo, attachments, and (via the code
agent + MCP) the running app and design files.
**Writes to:** Xray (Cucumber tests + links), the target repo (test code), git
(branch + commit), Azure DevOps (push, PR, comment threads), proposal PRs to the
agent repo, `out/` artifacts, and the OTel backend (when `OTEL_ENABLED=true`).

---

## 3. End-to-end pipeline

```mermaid
%%{init: {"theme":"base","themeVariables":{"primaryColor":"#eef2ff","primaryTextColor":"#111827","primaryBorderColor":"#818cf8","lineColor":"#94a3b8","secondaryColor":"#e0f2fe","tertiaryColor":"#f8fafc","clusterBkg":"#f8fafc","clusterBorder":"#e2e8f0","fontFamily":"Segoe UI, Roboto, Helvetica, Arial, sans-serif","fontSize":"14px","edgeLabelBackground":"#ffffff"},"flowchart":{"curve":"basis","htmlLabels":true,"padding":12,"nodeSpacing":50,"rankSpacing":55}}}%%
graph TD
    Ticket["Jira ticket key (QATG-1234)"]

    subgraph DesignPhase["design-tests"]
        direction TB
        Researcher["Researcher<br/>(+ ADF, linked tickets,<br/>attachments, evidence graph)"]
        Deep["Agentic retrieval (--deep)<br/>BM25 tool-loop"]
        ACExtract["AC extraction · LLM"]
        Gherkin["Gherkin authoring · LLM<br/>(+ step reuse + dedup)"]
        Coverage["Coverage Auditor<br/>bounded retry"]
        XraySink["Xray sink<br/>Cucumber + link"]
        Researcher --> Deep --> ACExtract --> Gherkin --> Coverage --> XraySink
    end

    Ticket --> Researcher
    Researcher -. writes .-> CP[("out/KEY/context.json + .md")]
    Coverage -. writes .-> TDP[("out/KEY/test-design.json + .md<br/>features/*.feature")]
    XraySink -. creates .-> XrayTests(("Cucumber tests linked to KEY"))

    subgraph ImplPhase["implement-tests"]
        direction TB
        Implementer["Implementer<br/>Claude/Codex/Shell + MCP tools"]
        Verifier["Verifier · verifyCommand"]
        Healer["Healer · ≤ max-heal-attempts"]
        Commit["branch + commit + push"]
        PR["VcsAdapter.raisePullRequest"]
        Implementer --> Verifier
        Verifier -->|exit 0| Commit
        Verifier -->|fail| Healer --> Verifier
        Commit --> PR
    end

    TDP --> Implementer
    PR -. creates .-> AzurePR(("Pull request"))
    PR -. writes .-> IP[("out/KEY/implementation.json + .md")]

    subgraph LoopPhase["respond-to-pr (triggered by a PR comment)"]
        direction TB
        Threads["Read PR threads"]
        Route{"Mention?"}
        Fix["@manso fix → scoped agent + re-verify + reply"]
        Know["@update-knowledge → guideline PR (project)"]
        Agent["@update-agent → guideline PR (Manso repo)"]
        Threads --> Route
        Route -->|"@manso"| Fix
        Route -->|"@update-knowledge"| Know
        Route -->|"@update-agent"| Agent
    end

    AzurePR --> Threads
    Fix -. learnings .-> Learn[("Learning engine<br/>transient vs systemic")]
    Know -. proposes .-> GPR(("Guideline review PR"))
    Agent -. proposes .-> APR(("Agent-repo review PR"))
```

Gates & guards: Coverage Auditor (`policy.gates.acCoverage`), heal budget
(`--max-heal-attempts`), PR loop-safety (`pr.maxIterationsPerPr` + bot markers),
eval release gate, and sandbox profiles. Learnings are **always proposed via a
separate human-reviewed PR — never applied silently.**

---

## 4. Layered component view

Source tree grouped by responsibility; arrows point toward dependencies.

```mermaid
%%{init: {"theme":"base","themeVariables":{"primaryColor":"#eef2ff","primaryTextColor":"#111827","primaryBorderColor":"#818cf8","lineColor":"#94a3b8","secondaryColor":"#e0f2fe","tertiaryColor":"#f8fafc","clusterBkg":"#f8fafc","clusterBorder":"#e2e8f0","fontFamily":"Segoe UI, Roboto, Helvetica, Arial, sans-serif","fontSize":"14px","edgeLabelBackground":"#ffffff"},"flowchart":{"curve":"basis","htmlLabels":true,"padding":12,"nodeSpacing":50,"rankSpacing":55}}}%%
graph TB
    subgraph EntryLayer["Entry · src/cli/"]
        CLI["main.ts dispatcher<br/>init · check · fetch · skills ·<br/>design-tests · implement-tests ·<br/>respond-to-pr · eval"]
    end

    subgraph AgentLayer["Agents · src/agents/"]
        Researcher["researcher/<br/>+ agenticRetrieval"]
        TestArchitect["testArchitect/<br/>acExtraction · gherkinAuthoring · prompts"]
        CoverageAuditor["coverageAuditor/"]
        Implementer["implementer/ · verifier/ · healer/"]
        Responder["responder/<br/>mention · prompts"]
        Learning["learningEngine/<br/>classify · proposer · knowledgeUpdate"]
    end

    subgraph ContextLayer["Context · src/context/ + src/shared/"]
        ProviderRegistry["providerRegistry + providers/"]
        Adf["shared/adf (ADF→MD)"]
        Evidence["evidenceGraph"]
        Attach["attachmentAnalysis · visionAnalysis"]
        Knowledge["knowledgeIndex (BM25)"]
        StepLib["stepLibrary"]
    end

    subgraph SkillsLayer["Skills · src/skillLoader/ + skills/ + .agents/skills/"]
        SkillLoader["parser + resolver"]
        PackagedSkills["skills/ (9 packaged)"]
        RepoSkills[".agents/skills/ overrides"]
    end

    subgraph IntegrationsLayer["Integrations · src/integrations/"]
        AtlassianRest["atlassianRest/ + atlassian/normalizers"]
        XrayInt["xray/"]
        LlmInt["llm/<br/>factory · clients · agentRunner ·<br/>sandbox · telemetry"]
        Mcp["mcp/config"]
        Vcs["vcs/ (VcsAdapter + AzureDevOps)"]
        Git["git/branchCommit · shell/"]
    end

    subgraph PolicyLayer["Governance + Eval · src/policy/ + src/eval/"]
        Redaction["redaction · budget · auditLog"]
        EvalH["scorer · harness"]
    end

    subgraph ConfigLayer["Config · src/config/ + scaffold/ + checks/"]
        RuntimeConfig["runtimeConfig"]
        AgentConfig["agentConfig"]
        Scaffold["scaffold + stackDetection"]
        Readiness["checks/readiness"]
    end

    subgraph ArtifactLayer["Artifacts · src/domain/ + src/output/"]
        Domain["domain/ schemas (6 packs)"]
        Writers["output/ writers"]
    end

    CLI --> AgentLayer
    CLI --> ConfigLayer
    CLI --> PolicyLayer
    AgentLayer --> ContextLayer
    AgentLayer --> SkillsLayer
    AgentLayer --> IntegrationsLayer
    AgentLayer --> ArtifactLayer
    AgentLayer --> PolicyLayer
    ContextLayer --> IntegrationsLayer
    IntegrationsLayer --> Domain
    ConfigLayer --> Domain
```

Notable shape:
- The **Agent Layer** is the only place that combines providers, skills,
  integrations, policy, and artifacts; everything below is a pure capability.
- The **Skills** layer is read-only data with no code dependencies into the rest.
- The **VcsAdapter** is a single seam — **`AzureDevOpsAdapter`** and
  **`GitHubAdapter`** sit behind `resolveVcsAdapter` (remote auto-detection).
  The platform token authenticates both the REST API (PR + comments) and the
  `git push` (via `resolveGitPushAuth` → `git -c http.extraHeader`), so
  unattended/pipeline runs need no local git credentials; absent a token, the
  push falls back to local credentials.
- The **Artifact Layer** (Zod schemas + writers) is the contract every stage
  emits before hand-off.

---

## 5. Multi-agent topology

```mermaid
%%{init: {"theme":"base","themeVariables":{"primaryColor":"#eef2ff","primaryTextColor":"#111827","primaryBorderColor":"#818cf8","lineColor":"#94a3b8","secondaryColor":"#e0f2fe","tertiaryColor":"#f8fafc","clusterBkg":"#f8fafc","clusterBorder":"#e2e8f0","fontFamily":"Segoe UI, Roboto, Helvetica, Arial, sans-serif","fontSize":"14px","edgeLabelBackground":"#ffffff"},"flowchart":{"curve":"basis","htmlLabels":true,"padding":12,"nodeSpacing":50,"rankSpacing":55}}}%%
graph LR
    Start([design-tests]) --> Researcher
    Researcher --> CP[(ContextPack<br/>+ evidence graph)]
    CP --> ACExtract[AC Extraction · LLM]
    ACExtract --> CPe[(ContextPack + ACs)]
    CPe --> GherkinAuthor[Gherkin Authoring · LLM]
    GherkinAuthor --> Draft[(TestDesignPack draft)]
    Draft --> Audit[Coverage Auditor]
    Audit -->|gaps| Retry[Scoped retry] --> Draft
    Audit -->|covered| TDP[(TestDesignPack)]
    TDP --> XraySink[Xray sink] --> XrayTests((Cucumber tests))

    StartImpl([implement-tests]) --> Implementer
    TDP --> Implementer
    Implementer --> IP[(ImplementationPack)]
    IP --> Verifier
    Verifier -->|exit 0| Commit[Commit + token-auth push]
    Verifier -->|fail| Healer --> Verifier
    Commit --> RaisePR[VcsAdapter · Azure / GitHub] --> AzurePR((Pull request))

    StartLoop([respond-to-pr]) --> Responder
    AzurePR --> Responder
    Responder -->|fix| FeedbackFix[Scoped fix + verify + reply]
    Responder -->|update| LearningEngine[Learning engine]
    LearningEngine --> Proposer[Proposer] --> ReviewPR((Guideline review PR))
```

Each box is an independently-testable unit reached through a `runX(input)`
library entry point; every artifact node is a Zod schema in `src/domain/`.

---

## Technology stack

| Area | Technology |
|---|---|
| Language / runtime | TypeScript, Node ≥20, ESM (NodeNext), `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| Validation | Zod v4 (every artifact + config) |
| Tests / tooling | Vitest, tsx, tsc |
| Design LLM | Anthropic Messages, OpenAI Responses, OpenAI/Azure OpenAI Chat Completions (auto-detected); multimodal (vision) |
| Code agent | Claude Agent SDK, OpenAI Codex SDK, Shell runner |
| Tools | MCP (stdio / http / sse) — Playwright, Figma |
| Issue tracking | Jira Cloud REST v3 + GraphQL dev-info; Confluence REST |
| Test management | Xray Cloud GraphQL (Cucumber test type) |
| VCS | Azure DevOps REST + GitHub REST (PRs + comment threads), git CLI |
| Observability | OpenTelemetry + Arize OpenInference → Phoenix / Langfuse |
| Retrieval | BM25 (lexical, no embedding API) |

---

## Roadmap (next milestones)

Detailed specs: **[ROADMAP.md](./ROADMAP.md)**.

| ID | Milestone | What changes |
|---|---|---|
| 🔥 **M20** | **Environment-aware, explore-before-implement** | **Spin up the app (Docker) once around the run; explore the live UI (Playwright MCP → real DOM locators) or API (OpenAPI/Swagger → endpoints + schemas) to ground the tests; implement, verify against the running env, tear down. Adds stack `kind`/`setupCommand`/`teardownCommand`/`appUrl`/`openApiUrl`. Highest-priority quality milestone.** |
| M19 | Xray Manual-test upload | Upload plain-English scenarios to Xray as Manual tests (Gherkin already uploads as Cucumber). |
| — | Devcontainer/Dagger sandbox | Run the code agent in an isolated container mapped to sandbox profiles. |
| — | More stacks | Cypress + others — one binding skill + one verify config + one eval repo each. |

**Delivered since the MVP:** M17 GitHubAdapter (PR + comment threads for
github.com/Enterprise); **token-based push auth** (`resolveGitPushAuth` →
`git -c http.extraHeader`) so the VCS token authenticates the `git push` as well
as the REST API, with a fallback to local git credentials; **M15** budget
enforcement (daily cost ledger + halt + `budget.breached`); **M16** audit
emission at every mutating action + the `manso audit` reader; **M21** the
`humanReviewBeforeUpload` gate (auto-confirm Xray upload for unattended runs) —
together these make Manso safe to run unattended in a pipeline.

---

## Cross-cutting concerns

| Concern | Where |
|---|---|
| Configuration | `src/config/` — env (`runtimeConfig`) + per-repo JSON (`agentConfig`) |
| Skills (progressive disclosure) | `src/skillLoader/` + `skills/` + `.agents/skills/` (repo overrides win) |
| Artifact contracts | `src/domain/*/schema.ts` — Zod-validated, `schemaVersion` + `provenance` + `warnings` |
| Provenance + warnings | Every external call records `{method, toolName, calledAt, success}` into the pack |
| Secrets / PII | `.env` only (gitignored); MCP `${ENV_VAR}` expansion; redaction before logs/telemetry/audit |
| Sandbox | `src/integrations/llm/sandbox.ts` — `MANSO_SANDBOX` profile |
| Telemetry | `src/integrations/llm/telemetry/` — OTel; no-op when `OTEL_ENABLED=false`; flushed on exit |
| Validation tests | `test/*.test.ts` — 279 tests, fixture/mock-based, no network |
