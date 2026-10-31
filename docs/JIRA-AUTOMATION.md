# Creating a Jira automation rule to run Manso

This guide shows how to wire a **Jira automation rule** that triggers the
Manso Azure pipeline for a ticket. It complements [PIPELINE.md](./PIPELINE.md)
(which covers the pipeline + secrets) — read that first if the pipeline isn't
set up yet.

A rule does one thing: on some trigger, send an HTTP **POST** to the Azure
DevOps *Pipelines — Run pipeline* REST API with `templateParameters` telling
Manso what to do (`mode`, `issueKey`, target repo, etc.).

---

## Prerequisites

1. The runner pipeline exists (`pipelines/run-hosted.yml` recommended) and you
   know its **definition id** — call it `<RUN_PIPELINE_ID>`.
   - Find it in the pipeline's URL: `…/_build?definitionId=<RUN_PIPELINE_ID>`.
2. The `manso-secrets` variable group is populated (see PIPELINE.md), including
   the `OTEL_*` set if you want Langfuse traces.
3. An **automation PAT** (Azure DevOps Personal Access Token) with scope
   **Build (Read & execute)** / **Pipelines (Read & execute)**. If the *same* PAT
   also does the git push/PR, add **Code (Read & Write)** + **Pull Request (Read & Write)**.
4. Your org/project slugs for the REST URL: `https://dev.azure.com/<org>/<project>`.

> **Network:** Jira's automation egress must be allowed to reach
> `dev.azure.com`. (Conversely, the hosted agent must reach Jira/Xray/Langfuse —
> if you've allow‑listed Atlassian IPs, make sure the agent is covered.)

---

## Step 1 — Encode the PAT for Basic auth

Azure DevOps Basic auth uses an **empty username + the PAT** — so you base64
the string `:<PAT>` (note the leading colon). Run **one** of these locally with
your own PAT:

```powershell
# PowerShell
"Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(":PASTE_YOUR_PAT"))
```
```bash
# Git Bash / Linux / macOS
printf ':%s' 'PASTE_YOUR_PAT' | base64 | tr -d '\n'
```

Store the result as a **Jira automation secret** (Project settings → Automation →
⚙ → **Secrets**), e.g. `AZDO_BASIC`. You'll reference it as `{{secrets.AZDO_BASIC}}`.
Treat it as a credential (base64 is encoding, not encryption) and rotate the PAT
if it leaks.

---

## Step 2 — Create the rule

**Project settings → Automation → Create rule.**

1. **Trigger** — pick when it should fire. Recommended: **Issue transitioned**
   (e.g. *to* `Ready for Test`). Avoid "field value changed" / "issue updated"
   triggers that fire repeatedly — see *Avoid duplicate runs* below.
2. **Conditions (optional, recommended):**
   - **Issue type** = `Story` (so it doesn't fire on sub‑tasks/bugs).
   - Any project/label conditions you want.
3. **Action → Send web request**, configured as in Step 3.
4. Name the rule and **Turn it on**.

---

## Step 3 — The "Send web request" action

| Field | Value |
|---|---|
| **Web request URL** | `https://dev.azure.com/<org>/<project>/_apis/pipelines/<RUN_PIPELINE_ID>/runs?api-version=7.1` |
| **HTTP method** | `POST` |
| **Web request body** | **Custom data** (JSON) — see below |
| **Headers** | `Content-Type: application/json` and `Authorization: Basic {{secrets.AZDO_BASIC}}` |
| **Wait for response** | optional; turn on to see the response in the audit log |

### Body (custom data)

```json
{
  "templateParameters": {
    "mode": "design",
    "issueKey": "{{issue.key}}",
    "targetRepo": "https://dev.azure.com/<org>/<project>/_git/<repo>"
  }
}
```

`{{issue.key}}` is a Jira smart value resolved at fire time (e.g. `MPORTAL-2073`).

---

## Step 4 — One rule per mode

Create a separate rule (different trigger) for each behaviour you want. Only
`mode` changes:

| Purpose | Trigger (example) | `mode` |
|---|---|---|
| Generate test cases | transition → *Ready for Test* | `design` |
| Implement automated tests | transition → *Test Design Approved* | `implement` |
| Generate **and** implement | transition → *Ready for Test* | `both` |
| Analyse coverage gaps | scheduled / manual | `coverage` |

> `implement` / `both` **require** `targetRepo` (the agent writes code there) and
> raise a PR. `design` / `coverage` can run **without** `targetRepo` (issue‑only)
> — you just lose repo step‑reuse and the repo's `.agents` config.

---

## `templateParameters` reference

All except `mode` + `issueKey` are optional; omit (or send `""`) to use defaults.
Values are **strings** (Azure template parameters are strings) — JSON objects
must be embedded as an escaped string.

| Parameter | Values | Notes |
|---|---|---|
| `mode` | `design` \| `implement` \| `both` \| `coverage` | Required. |
| `issueKey` | `{{issue.key}}` | Required. |
| `targetRepo` | clone URL | Required for `implement`/`both`; optional for `design`/`coverage`. |
| `testFields` | JSON object string | Extra Jira fields on created Test issues (project‑mandatory fields). See below. |
| `reporter` | `{{initiator.accountId}}` | Sets the **Reporter** on created Test issues to the person who triggered the rule, so each QA's runs are attributed to them (the shared pipeline credential remains the Creator). Requires the authenticated account to hold the project's **Modify Reporter** permission. An explicit `reporter` key inside `testFields` wins over this parameter. |
| `deriveRequirements` | `true` \| `false` | **M22:** mine implied requirements beyond the ACs. **Default ON** for every run (repo or repo‑less); send `false` to disable. |
| `adversarialCritique` | `true` \| `false` | **M22:** run the "what did we miss?" pass. **Default ON.** |
| `riskCoverage` | `required` \| `warn` \| `off` | **M22:** the risk/edge gate. **Default `warn`.** |

### Full example (design, with mandatory field + per‑QA reporter + M22)

```json
{
  "templateParameters": {
    "mode": "design",
    "issueKey": "{{issue.key}}",
    "targetRepo": "https://dev.azure.com/afs-dev/bnpl-finance/_git/general-ledger-e2e",
    "testFields": "{\"customfield_15714\": 170}",
    "reporter": "{{initiator.accountId}}",
    "deriveRequirements": "true",
    "adversarialCritique": "true",
    "riskCoverage": "warn"
  }
}
```

---

## Project‑mandatory fields (`testFields`)

Some projects require a custom field when **creating** a Test issue (e.g. a Tempo
**Account**). Manso auto‑inherits *primitive* required fields from the story,
but **structured** ones (Tempo account, selects) must be supplied via `testFields`.

**Find the field id + required write value** for a project's *Test* issue type:

1. Project → issue types → find the **Test / Test Case** type id, then check its
   create metadata: `GET /rest/api/3/issue/createmeta?projectKeys=<PROJ>&issuetypes=<id>&expand=projects.issuetypes.fields`.
2. The field shows `required: true`, its `customfield_NNNNN` id, and (for
   selects) `allowedValues` with the ids to use.
3. Send the **write** value — usually a bare id for Tempo accounts, sometimes
   `{"id":"…"}` or `{"value":"…"}` for selects. (A wrong shape gives an
   *"Operation value must be a number"*‑type error.)

**Worked example — `MPORTAL`:** the Test Case type requires `customfield_15714`
("Account", Tempo). Allowed: `170` = *T_Exp Change*, `171` = *T_Exp Run*. Write
value is the bare number:

```json
"testFields": "{\"customfield_15714\": 170}"
```

---

## Gotchas

- **Escape the JSON inside `testFields`** so the whole body stays valid JSON:
  `"testFields": "{\"customfield_15714\": 170}"`.
- **Avoid duplicate runs.** Re‑triggering `design` on the same ticket can create
  reworded near‑duplicate tests (upload de‑dup matches on *exact* title). Fire
  the `design` rule **once** per ticket (a specific transition), not on every
  edit.
- **`mode` must be one of the allowed values** or the run is rejected.
- **401 from Azure** → check the Basic header is `base64(":"+PAT)` (leading colon,
  no trailing newline) and the PAT has *Pipelines: Read & execute*.
- **Missing‑parameter error** → the pipeline's YAML branch must include the
  parameter. The pipeline reads its YAML from its configured default branch;
  if you added a new parameter, make sure that branch has it.
- **No Langfuse session?** Confirm `OTEL_ENABLED=true` + the full `OTEL_*` set in
  the variable group, and check the pipeline's "Langfuse egress check" step
  prints `HTTP 200`.

---

## Verifying a rule

1. Trigger it (do the transition, or use Automation → **Run rule** for a manual
   trigger).
2. Jira: **Automation → Audit log** shows the rule fired and the HTTP response.
3. Azure DevOps: a new run of the pipeline appears with your `templateParameters`.
4. Output: created Test Cases are linked to the story as **"is tested by"**;
   `design`/`coverage` also publish the `manso-out` artifact; LLM activity
   traces to Langfuse under session `jira:<KEY>`.
