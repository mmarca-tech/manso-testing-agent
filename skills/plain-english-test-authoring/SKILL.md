---
name: plain-english-test-authoring
description: Author Xray-style plain-English manual test scenarios from extracted acceptance criteria.
appliesTo: { phase: design }
when: Use when testDesign.outputMode is "plain-english" — uploaded to Xray as Manual tests.
---

# Plain-English Test Authoring

Produce manual test scenarios in numbered Step / Expected Result form,
suitable for Xray's manual test type. Used when Gherkin is not the desired
output — e.g. exploratory or not-yet-automatable areas.

## Output contract

Each scenario is an object with:

| Field | Notes |
|---|---|
| `title` | Short imperative title, e.g. "Customer selects a 3-instalment plan". |
| `acIds` | Array of AC ids this scenario covers (`["AC-1", "AC-3"]`). |
| `risk` | `high` / `medium` / `low`. |
| `preconditions` | Bulleted list of states the system must be in before step 1. |
| `steps` | Numbered list of `{ action, data?, expectedResult }` objects. |
| `notes` | Optional reviewer notes — open questions, data assumptions. |

Example:

```yaml
- title: Customer selects a 3-instalment plan
  acIds: [AC-1]
  risk: high
  preconditions:
    - Customer is logged in
    - Order amount is 300.00 EUR and eligible for instalments
  steps:
    - action: Open the checkout page
      expectedResult: Instalment options are visible
    - action: Select the "3 instalments" plan
      expectedResult: Plan schedule shows 3 payments of 100.00 EUR; first payment is dated today
```

## Rules

- **One observable outcome per step.** Steps are checkpoints, not narration.
- **Business language only.** No CSS selectors, API paths, or implementation
  details.
- **Concrete data in `data`.** Do not embed values into prose if they can be
  isolated; the data column makes test maintenance and i18n variants cheap.
- **Number steps.** Reviewers and bug reports reference them by number.
- **Cover the negative path** when the AC implies it — as a separate scenario.
- **No secrets, no production credentials, no tenant-specific values.** Use
  placeholders and document them in `notes`.

## Anti-patterns

- Multi-action steps ("Open checkout and select the plan and confirm ...").
- Vague expected results ("Plan looks correct").
- Reusing the same AC across many shallow scenarios when one solid scenario
  would do.
