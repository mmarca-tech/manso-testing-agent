---
name: playwright-bdd-ts
description: Implement Gherkin step definitions with playwright-bdd in TypeScript.
appliesTo: { stacks: [playwright-bdd-ts], phase: implementation }
when: Use when the repo runs Playwright with the playwright-bdd package.
---

# playwright-bdd Implementation Guidance

This stack binds Gherkin scenarios to Playwright code through the
`playwright-bdd` package. Treat the `.feature` files as the source of truth;
only edit them when the design itself changes.

## Where things live

- **Feature files**: `<root>/<featureGlob>` from `.agents/manso.config.json`,
  typically `tests/e2e/features/**/*.feature`.
- **Step definitions**: alongside the features (e.g. `tests/e2e/steps/*.ts`)
  following the repository's existing layout — do not invent a new location.
- **Generated tests**: emitted under a generated folder by `bddgen`. Do not
  modify generated files; only the steps and features.
- **Page objects / helpers / fixtures**: reuse what the repository already
  has. Prefer extending an existing helper over creating a new one.

## Implementation contract

- One Playwright step definition per Given/When/Then text. Reuse a step where
  a matching text already exists.
- Prefer accessibility-first locators (`page.getByRole`, `getByLabel`,
  `getByTestId`). Never use raw CSS or XPath unless the repository guidance
  explicitly requires it.
- Wait for state, not time. No `page.waitForTimeout` and no `Thread.Sleep`
  equivalents. Use `expect.poll`, `expect(locator).toBeVisible()`, network
  waits.
- Step definitions stay thin: orchestrate, do not assert business logic.
  Assertions live in the `Then` steps using `expect`.
- Test data: pull from the repository's existing factories / builders. Never
  hardcode tenant ids, account ids, or production URLs.
- Configure tracing (`--trace=on-first-retry` or repo convention) — do not
  weaken existing trace settings to silence failures.

## Validation

Run the stack's `verifyCommand` (default `npx playwright test`) when changes
are complete. If a single feature is targeted, narrow with
`npx playwright test --grep @story-<KEY>`.

## Anti-patterns

- New page objects when an existing one already covers the area.
- Step definitions that read or mutate database state directly — go through
  the existing API client / factory.
- Re-tagging scenarios to skip them rather than fixing the underlying issue.
- Disabling retries to make CI green.
