# Testing Manso on a real Jira + Azure DevOps project

This guide walks you, step by step, through running Manso end-to-end against
a **real Jira story** and a **real Azure DevOps Git repository** from your local
machine. By the end you will have:

1. Gherkin test cases created in **Xray** and linked to the story.
2. A **branch + pull request** in Azure DevOps containing implemented automated
   tests.

> Run every `manso …` command from inside the `manso-claude` folder.
> Commands are shown for **PowerShell** (Windows). They also work in bash.

---

## 0. Prerequisites

| You need | Notes |
|---|---|
| Node.js ≥ 20 + npm | `node -v` |
| Git | The target repo must be a git clone with an `origin` remote |
| A target Azure DevOps repo, cloned locally | e.g. `C:\work\my-app` |
| A Jira story to test | Has a description and (ideally) acceptance criteria |
| Jira API token | https://id.atlassian.com/manage-profile/security/api-tokens |
| Xray Cloud API key (client id + secret) | Jira → Apps → Xray → API Keys |
| Azure DevOps PAT | With **Code (Read & Write)** + **Pull Request (Read & Write)** |
| A design LLM key | Azure OpenAI **or** Anthropic **or** OpenAI |
| An implementation LLM key | Anthropic (Claude Agent SDK) recommended |

---

## 1. Install & sanity-check Manso

```powershell
cd C:\MySpace\Projects\Manso\manso-claude
npm install
npm run check        # type-check
npm test             # full suite (no network) — optional but reassuring
```

You run the CLI with `npm run manso -- <verb> [options]` (no build needed).
Try:

```powershell
npm run manso -- --help
```

---

## 2. Configure credentials (`.env`)

```powershell
Copy-Item .env.example .env
notepad .env
```

Fill in the values below. Leave anything you are not using blank.

### Jira (required)
```
JIRA_URL=https://your-site.atlassian.net
JIRA_USERNAME=you@example.com
JIRA_API_TOKEN=<your Jira API token>
```

### Confluence (optional — only if your stories link to Confluence pages)
```
CONFLUENCE_ENABLED=true
CONFLUENCE_URL=https://your-site.atlassian.net/wiki
CONFLUENCE_USERNAME=you@example.com
CONFLUENCE_API_TOKEN=<same Jira API token usually works>
```

### Design LLM (required — used to extract ACs and author tests)

**Option A — Azure OpenAI:**
```
LLM_PROVIDER=openai
LLM_BASE_URL=https://<your-resource>.openai.azure.com/openai/v1
LLM_MODEL=<your deployment name, e.g. gpt-4o>
LLM_API_KEY=<your Azure OpenAI key>
```
**Option B — Anthropic:**
```
LLM_PROVIDER=anthropic
LLM_API_KEY=<your Anthropic key>
LLM_MODEL=claude-sonnet-4-6
```

### Implementation LLM (required for `implement-tests`)
The code agent uses the Claude Agent SDK (Anthropic) or Codex SDK (OpenAI).
Anthropic is recommended:
```
ANTHROPIC_API_KEY=<your Anthropic key>
IMPLEMENTATION_LLM_PROVIDER=anthropic
```
(If you leave `IMPLEMENTATION_LLM_*` blank it falls back to the design LLM.)

### Xray (required to create test cases)
```
XRAY_BASE_URL=https://xray.cloud.getxray.app
XRAY_CLIENT_ID=<xray client id>
XRAY_CLIENT_SECRET=<xray client secret>
XRAY_TEST_LINK_TYPE=Test
XRAY_TEST_LINK_DIRECTION=test-to-ticket
```
> **`XRAY_TEST_LINK_TYPE` must be the exact name of the Jira issue-link type**
> that connects a Test to your story. It is often `Test` or `Tests`. Find it in
> Jira → **Settings → Issues → Issue linking**. If it is wrong, tests get
> created but the link step warns/fails.

### Azure DevOps (required to raise the PR)
```
AZURE_DEVOPS_PAT=<your PAT>
```

### Safety / cost (recommended while testing)
```
MANSO_SANDBOX=workspace-write     # the code agent can write the repo but not run wild
```

---

## 3. Scaffold the `.agents/` folder in your target repo

```powershell
npm run manso -- init --repo C:\work\my-app
```

This creates `C:\work\my-app\.agents\`. Open
`C:\work\my-app\.agents\manso.config.json` and confirm/edit:

- **`product`** — your product name.
- **`stacks`** — at least one entry. Each stack needs:
  ```json
  {
    "id": "playwright-bdd-ts",
    "root": ".",
    "verifyCommand": "npx playwright test",
    "featureGlob": "tests/**/*.feature"
  }
  ```
  `verifyCommand` is what Manso runs to confirm the generated tests pass.
- **`pr.mention`** — defaults to `@manso`.
- **`policy.gates.humanReviewBeforePr`** — set `true` if you want Manso to
  push the branch but **not** open the PR automatically (you open it).

Then fill the `TODO` sections in `.agents/test-architecture.md`,
`.agents/product-context.md`, and add any rules to `.agents/guidelines/`. The
richer these are, the better the generated tests.

> Optional: add real conventions to `.agents/guidelines/*.md` (e.g. "always
> select by `data-testid`", "never use `Thread.Sleep`").

---

## 4. Check readiness

```powershell
npm run manso -- check --repo C:\work\my-app
```
Aim for a score **≥ 90**. Fix anything it flags (missing files, no stack, etc.).

---

## 5. Smoke-test the Jira connection

```powershell
npm run manso -- fetch --issue PROJ-123
```
You should see the normalized ticket (title, status, links, comment count). If
this fails, your Jira credentials or URL are wrong — fix before continuing.

---

## 6. Design tests — dry run first (no writes anywhere)

```powershell
npm run manso -- design-tests --issue PROJ-123 --repo C:\work\my-app --dry-run --out .\out
```

Inspect the output under `.\out\PROJ-123\`:
- `context.md` — everything Manso understood about the ticket.
- `test-design.md` — the proposed test strategy + scenarios.
- `features\*.feature` — the Gherkin.

If the scenarios look wrong, improve the ticket / `.agents/` guidelines and re-run.

> Add `--deep` to let the LLM drive extra retrieval before designing.

---

## 7. Design tests — create them in Xray

```powershell
npm run manso -- design-tests --issue PROJ-123 --repo C:\work\my-app --yes --out .\out
```

`--yes` confirms the upload. Then check in Jira/Xray:
- New **Cucumber** test issues exist.
- They are **linked to PROJ-123**.
- Re-running is idempotent (existing tests are skipped, not duplicated).

The Xray keys are recorded in `.\out\PROJ-123\test-design.json`.

---

## 8. Implement tests — local verify, no PR

Make sure your target repo is on a clean branch first.

```powershell
npm run manso -- implement-tests --repo C:\work\my-app --design .\out\PROJ-123\test-design.json
```

Manso drives the code agent to write step definitions, then runs your
stack's `verifyCommand` and heals simple failures. Inspect:
- The changed files in `C:\work\my-app`.
- `.\out\PROJ-123\implementation.md` — what it did, verify result, heal attempts.

> Add `--stack <id>` if you configured more than one stack.
> Add `--no-verify` to skip running the suite (faster first look).

---

## 9. Implement tests — raise a pull request

```powershell
npm run manso -- implement-tests --repo C:\work\my-app --design .\out\PROJ-123\test-design.json --pr
```

This commits on a `manso/PROJ-123` branch, pushes, and opens a PR in Azure
DevOps. Verify the branch + PR appear. (If `policy.gates.humanReviewBeforePr` is
`true`, it pushes the branch but does not open the PR — you open it.)

> Requires the target repo to have an Azure DevOps `origin` remote and
> `AZURE_DEVOPS_PAT` set. Add `--pr-dry-run` to rehearse without creating a PR.

---

## 10. (Optional) PR feedback loop

On the PR, leave a comment such as:
```
@manso the login selector should use data-testid, please fix
```
Then run:
```powershell
npm run manso -- respond-to-pr --repo C:\work\my-app --pr <PR-ID> --issue PROJ-123
```
Manso reads the comment, applies a scoped fix, re-verifies, and replies in
the thread. Use `--dry-run` first to see what it would do.

You can also teach it durable rules (each opens a **separate review PR**):
```
@update-knowledge always select by data-testid in this repo
```

---

## End-to-end recap

```powershell
npm run manso -- init          --repo C:\work\my-app
npm run manso -- check         --repo C:\work\my-app
npm run manso -- design-tests  --issue PROJ-123 --repo C:\work\my-app --yes --out .\out
npm run manso -- implement-tests --repo C:\work\my-app --design .\out\PROJ-123\test-design.json --pr
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No LLM configured…` | Set `LLM_PROVIDER` + `LLM_API_KEY` (and `LLM_MODEL`) in `.env`. |
| Tests created in Xray but **not linked** to the story | `XRAY_TEST_LINK_TYPE` doesn't match your Jira link-type name. Check Jira → Settings → Issues → Issue linking. |
| `Jira credentials are not configured` | Set `JIRA_URL`, `JIRA_USERNAME`, `JIRA_API_TOKEN`. |
| `--pr: … remote … not … set` | Ensure the target repo's `origin` is Azure DevOps and `AZURE_DEVOPS_PAT` is set. |
| `No Manso config found…` | Run `manso init --repo <repo>` first. |
| Implement agent makes no changes | Check the implementation LLM key (`ANTHROPIC_API_KEY`), and that the stack `verifyCommand` is correct. |
| Want to see tokens/cost | Set `OTEL_ENABLED=true` + a Langfuse/Phoenix backend (see `.env.example`). |

---

## Safety notes

- Secrets live **only** in `.env` (gitignored) — never commit them.
- `design-tests --dry-run` and `implement-tests` (without `--pr`) make **no**
  external writes you can't undo. Use them freely while you build confidence.
- The first external write to Xray needs `--yes`; the PR needs `--pr`.
