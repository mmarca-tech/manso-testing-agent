# Running Manso from Jira via an Azure Pipeline

Manso runs **unattended** from three Jira automation rules, each triggering
**one parameterized pipeline** (`pipelines/run.yml`) with a different `mode`:

| Jira rule | `mode` | What it does |
|---|---|---|
| Generate test cases | `design` | `design-tests --issue <KEY> --yes` → Gherkin in Xray (linked "is tested by") |
| Implement automated tests | `implement` | `implement-tests --issue <KEY> --pr` → **reconstructs the design from Xray**, implements the tests not yet in the repo, raises a PR |
| Ticket Ready → handover | `both` | design, then implement, in one run |
| Analyse coverage gaps | `coverage` | `analyse-coverage --comment --create-tests` → assess the linked tests vs the story, post the gap analysis as a Jira comment, and create the missing Cucumber tests in Xray (reusing existing step phrasings) |

Because the implement step is **Xray-sourced** (`--issue`, no local design file), rule #2 works as a standalone run — it doesn't depend on artifacts from rule #1.

## Two runner flavours — pick one

| Runner | Needs | When |
|---|---|---|
| **`pipelines/run-hosted.yml`** (quick start) | Only the `manso-secrets` variable group + permission to create pipelines (both are **Azure DevOps** permissions). No container registry or Azure subscription/RBAC. | Get going today. Builds Manso from source on a hosted agent each run (~1–2 min extra). |
| **`pipelines/run.yml`** (production) | The GHCR image + a Docker Registry service connection with package read access. | Faster cold starts; M20-ready. |

Both take the same Azure DevOps variable group. `run-hosted.yml` builds Manso from source; `run.yml` pulls the GHCR image.

### Pipeline parameters

`run-hosted.yml` accepts (all but `mode`/`issueKey` optional; blank = default):

| Parameter | Values | Notes |
|---|---|---|
| `mode` | `design` \| `implement` \| `both` \| `coverage` | Required. |
| `issueKey` | e.g. `MPORTAL-2073` | Required. |
| `targetRepo` | clone URL | **Optional for `design`/`coverage`** (runs issue‑only); **required for `implement`/`both`** (the agent writes code there). |
| `testFields` | JSON object string | Project‑mandatory Jira fields on created Test issues, e.g. `{"customfield_15714":170}` (merged over the repo's `xray.testFields`). |
| `reporter` | Jira accountId | Set as **Reporter** on created Test issues — pass `{{initiator.accountId}}` from the Jira rule so tests are attributed to the triggering QA. Needs the project's *Modify Reporter* permission for the authenticated account. |
| `deriveRequirements` | `true`/`false` | M22 — mine requirements beyond the ACs. **Default ON** (blank = on); set `false` to disable. |
| `adversarialCritique` | `true`/`false` | M22 — "what did we miss?" pass. **Default ON.** |
| `riskCoverage` | `required`/`warn`/`off` | M22 — risk/edge gate. **Default `warn`.** |

> `run.yml` (the GHCR image variant) has **full parameter parity** with `run-hosted.yml` — keep the two files in sync when adding parameters.

See **[JIRA-AUTOMATION.md](./JIRA-AUTOMATION.md)** for the full rule‑creation walkthrough.

## Proactive PR validation

The separate `review-pull-request` verb can run in a consumer repository's
Azure Repos **build-validation branch policy**. It does not alter the Jira
design/implement/handover modes. Install Manso from your approved package
feed (or use its built image), then run it against the consumer checkout:

```yaml
- script: >
    npx manso review-pull-request
    --repo "$(Build.SourcesDirectory)"
    --out "$(Build.ArtifactStagingDirectory)/manso-review"
  displayName: Proactive Manso PR review
  env:
    SYSTEM_ACCESSTOKEN: $(System.AccessToken)
    SYSTEM_PULLREQUEST_PULLREQUESTID: $(System.PullRequest.PullRequestId)
    JIRA_URL: $(JIRA_URL)
    JIRA_USERNAME: $(JIRA_USERNAME)
    JIRA_API_TOKEN: $(JIRA_API_TOKEN)
    LLM_PROVIDER: $(LLM_PROVIDER)
    LLM_MODEL: $(LLM_MODEL)
    LLM_API_KEY: $(LLM_API_KEY)
- publish: $(Build.ArtifactStagingDirectory)/manso-review
  artifact: manso-review
  condition: always()
```

Use an approved pinned package version rather than fetching an unpinned
public package. The consumer repo must contain `.agents/manso.config.json`;
its `policy` config controls budgets, custom redaction, and deployment pricing
(see [README](../README.md#proactive-pull-request-review)). The build service
needs repository read and PR-comment permissions, not push rights. Enable
OAuth-token access for scripts as required by your Azure agent configuration.
Map Confluence and custom LLM endpoint variables if needed by your deployment.

The PR ID defaults to Azure pipeline variables; the repository remote selects
the VCS adapter. Locally or for GitHub, pass `--repo` / `--pr` explicitly and set
`GITHUB_TOKEN`. `--issue` overrides Jira-key detection. Posting is on by default:
located findings become inline diff threads (including removed lines), followed
by one summary with overall results and unlocated findings. Azure inline threads
require reading PR iterations/changes and writing PR threads; GitHub needs
pull-request review-comment write permission. `--no-comment` or `--dry-run`
suppresses both kinds of comment for artifact-only validation. No votes or code
changes are made. Recommendation values are advisory, not build approval votes.

To enforce daily budgets across separate hosted jobs, configure
`MANSO_COST_LEDGER` on persistent storage and share it across review runs;
an ephemeral artifact directory alone cannot enforce a cross-run daily cap.

---

## One-time setup

> The GHCR service connection is only needed for `run.yml`. The hosted runner does not need container registry access.

### 1. Container registry (GHCR)
- GitHub Actions publishes `ghcr.io/mmarca-tech/manso-testing-agent:main` on pushes to `main` and versioned images during release.
- GHCR packages are private by default. In Azure DevOps → Project Settings → **Service connections**, add a **Docker Registry** connection for `ghcr.io` using a GitHub PAT classic with `read:packages`; use it as `<GHCR_SERVICE_CONNECTION>` in `pipelines/run.yml`.
- If you make the GHCR package public, the Azure runner can pull anonymously and the `endpoint` can be removed.

GitHub Actions in `.github/workflows/` run CI, publish the `main` image, and manually release npm and container packages. The old Azure CI and release pipeline definitions are retired.

### 2. Secrets — variable group `manso-secrets`
Create a **variable group** named `manso-secrets` (ideally linked to **Key Vault**) with the variables below (same names the app reads from `.env`). Mark all credentials **secret**.

| Variable | Notes |
|---|---|
| `JIRA_URL`, `JIRA_USERNAME`, `JIRA_API_TOKEN`, `JIRA_CLOUD_ID` | Jira Cloud REST |
| `XRAY_BASE_URL`, `XRAY_CLIENT_ID`, `XRAY_CLIENT_SECRET` | Xray Cloud |
| ~~`XRAY_TEST_LINK_TYPE` / `XRAY_TEST_LINK_DIRECTION`~~ | **Not needed** — the link relationship defaults to **"is tested by"** in code. Only set these to override for a Jira instance whose link type differs. |
| `AZURE_DEVOPS_PAT` | For **Azure DevOps** target repos: drives the REST PR/comments, the `git push`, and the clone. Scopes: **Code (Read & Write)** + **Pull Request (Read & Write)**. |
| `GITHUB_TOKEN` | For **GitHub** target repos: drives the clone, push, and PR. Scopes: **contents:write** + **pull_requests:write** (read suffices for design-only). **For an org repo the PAT must actually reach it**: a classic PAT needs SSO authorization for that org; a fine-grained PAT must be granted on the org/repo. The clone step preflights the token and fails with a precise message if it is missing or rejected. |
| `LLM_PROVIDER`, `LLM_MODEL` | Design LLM selection |
| `IMPLEMENTATION_LLM_PROVIDER`, `IMPLEMENTATION_LLM_MODEL`, `IMPLEMENTATION_LLM_BASE_URL`, `IMPLEMENTATION_LLM_API_KEY` | Implementation agent selection. **Optional** — omit and the implement step reuses the design LLM. `IMPLEMENTATION_LLM_BASE_URL` is needed for an Azure‑hosted Codex model — use the resource's `https://<name>.openai.azure.com/openai/v1` host, **not** `services.ai.azure.com` (its WebSocket replies 302; Manso warns at startup). |
| `MANSO_MODEL_PRICES` | **Optional.** JSON of USD‑per‑1M‑token prices for cost estimation, e.g. `{"my-deployment":{"input":1.75,"cachedInput":0.175,"output":14}}`. Only needed when a model/deployment name doesn't contain a known model name (built‑ins cover gpt‑5.3‑chat/codex, gpt‑5.5, Claude Sonnet/Haiku/Opus). Already mapped in both runner YMLs. |
| `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` | **The actual API keys.** Add the key(s) for whichever provider(s) you use. The Claude agent (anthropic) authenticates via **`ANTHROPIC_API_KEY`** specifically; the Codex agent (openai) via `OPENAI_API_KEY`. (`LLM_API_KEY` / `IMPLEMENTATION_LLM_API_KEY` also work for OpenAI, but Claude needs `ANTHROPIC_API_KEY`.) |
| `OTEL_PROVIDER`, `OTEL_ENABLED`, `OTEL_ENDPOINT`, `OTEL_PUBLIC_KEY`, `OTEL_SECRET_KEY` | Langfuse/Phoenix tracing |

> In a container job, secret variables are **not** auto-exposed — `run.yml` maps each one into the step `env:` explicitly. Add any new secret to both the group and the step `env:`.

### 3. Create the runner pipeline
Create a pipeline from **`pipelines/run-hosted.yml`** (quick start, no image) or `pipelines/run.yml` (GHCR image). Note its **definition id** (the `pipelineId` used in the REST call below). Its trigger is `none` — it only runs when called.

> CLI: `az pipelines create --name manso-run --repository agent-manso --repository-type tfsgit --branch main --yaml-path pipelines/run-hosted.yml --skip-first-run true` — needs only Azure DevOps permissions, no Azure RBAC.

---

## Wiring the 3 Jira automation rules

Each rule ends with a **Send web request** action calling the Azure DevOps Pipelines REST API:

- **URL:** `https://dev.azure.com/afs-dev/<project>/_apis/pipelines/<runPipelineId>/runs?api-version=7.1`
- **Method:** `POST`
- **Headers:** `Content-Type: application/json`, `Authorization: Basic <base64(":"+AUTOMATION_PAT)>`
- **Body (rule #1 — design):**
  ```json
  { "templateParameters": { "mode": "design", "issueKey": "{{issue.key}}", "targetRepo": "https://dev.azure.com/afs-dev/<project>/_git/<repo>" } }
  ```
- **Rule #2 — implement:** same body with `"mode": "implement"`.
- **Rule #3 — handover:** same body with `"mode": "both"`.

`AUTOMATION_PAT` is a dedicated PAT with **Build/Pipelines (Read & execute)**, stored as a Jira secret (Automation → ⚙ → Secrets), referenced as `{{secrets.AUTOMATION_PAT}}` (or in a Smart Value). It can be the same identity as `AZURE_DEVOPS_PAT` if that PAT also has pipeline-run scope.

Add the optional parameters to the body as needed, e.g. for a project with a mandatory field and M22 on:
```json
{ "templateParameters": {
  "mode": "design", "issueKey": "{{issue.key}}",
  "targetRepo": "https://dev.azure.com/afs-dev/<project>/_git/<repo>",
  "testFields": "{\"customfield_15714\": 170}",
  "deriveRequirements": "true", "adversarialCritique": "true", "riskCoverage": "warn"
} }
```
The full step‑by‑step (trigger, conditions, PAT encoding, finding mandatory field ids) is in **[JIRA-AUTOMATION.md](./JIRA-AUTOMATION.md)**.

---

## What you get per run
- **design / both:** Cucumber tests created in Xray and linked to the story as **"is tested by"**.
- **implement / both:** a PR on the target repo containing the step definitions / page objects for the tests **not already in the repo**. The design artifacts + audit log are published as the `manso-out` pipeline artifact.
- All LLM activity traces to Langfuse under session `jira:<KEY>`.

## Verify & the environment (M20)
If the target stack configures a `setupCommand` (Docker) + `appUrl`/`healthCheck`, the implement run is **environment‑aware**: it brings the app up once, explores it for real locators/endpoints, verifies against it, and tears it down (tune the boot wait with `stack.readinessTimeoutMs`). **Without** Docker infra, `verify` (`npm run test:ui`) runs with no app behind it and is **red** — the run reports `partial` and **the PR is still raised for human review**. See [CHANGELOG.md](./CHANGELOG.md) / `docs/ROADMAP.md` (M20).

**What a target stack needs for env‑aware runs on CI.** The environment block falls back gracefully when any of these is missing, so a "passed" run does *not* prove a live‑app verify — check the artifact for `out/<KEY>/exploration.md` to know which happened. For it to actually work, the target repo's compose must be **hermetic on the runner**:

- **No external bind mounts** — everything builds from the repo itself (a mount like `${EMPLOYEE_FRONTEND_FRAMEWORK_PATH}` to a sibling checkout cannot exist on a hosted agent).
- **Published host ports** (`ports: ["4200:4200"]`) so `stack.appUrl`/`healthCheck` on `localhost` are reachable from the Manso process.
- **Secrets via env** mapped into the step (auth client ids/secrets the compose needs).
- **A realistic `readinessTimeoutMs`** for slow boots (an Nx serve that compiles on start can take ~8 min).
- A runner with **Docker available** — `run-hosted.yml` (hosted Ubuntu agent) has it; a container job (`run.yml`) would need docker‑in‑docker. Heavy stacks are better served by a **self‑hosted agent** that has the sibling repos + secrets.

## Governance notes
- The **per-run** cost cap (`policy.budgets.maxCostPerRunUsd`) needs no persistence. The **daily** cap (`maxCostPerDayUsd`) reads a ledger file — on ephemeral agents point `MANSO_COST_LEDGER` at durable storage, or rely on the per-run cap.
- Every mutating action (Xray upload, PR raised, budget breach) is written to the audit log published with the artifact; read it with `manso audit --log <path>`.
