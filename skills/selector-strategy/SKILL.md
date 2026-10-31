---
name: selector-strategy
description: Choose resilient, accessibility-first locators and heal brittle ones.
appliesTo: { phase: implementation }
when: Use whenever authoring or repairing UI test locators, with or without a live-app MCP server.
---

# Selector Strategy

Locators are the most common cause of flaky UI tests. Choose them so a cosmetic
markup change does not break a passing test, and so the test asserts the thing a
user actually perceives.

## Priority order (highest first)

1. **Role + accessible name** — `getByRole('button', { name: 'Sign in' })`.
   Mirrors how a user (and assistive tech) finds the control.
2. **Label / placeholder / text** — `getByLabel`, `getByPlaceholder`,
   `getByText` for form fields and visible copy.
3. **Test id** — `getByTestId('checkout-submit')` when the repo uses stable test
   ids. Add one to the product only if repo conventions explicitly allow it;
   otherwise prefer a role/label locator over inventing markup.
4. **CSS scoped to a stable container** — only when 1–3 cannot identify the
   element. Anchor to a semantic ancestor, never a deep brittle chain.
5. **XPath** — last resort, and only if the repository already uses it.

## Rules

- One locator should resolve to exactly one element. If it is ambiguous, scope
  it (`within` a region) rather than relying on `.first()`.
- Never select on auto-generated classes, hashed ids, or DOM position
  (`nth-child`) — these change without notice.
- Assert on user-visible state (text, role, value, URL), not internal DOM
  details.
- Wait for state, not time: `expect(locator).toBeVisible()`, `expect.poll`,
  response waits. No fixed sleeps.

## Healing a brittle locator

When a locator fails or is flaky:

1. Re-observe the real element (via the Playwright MCP server when available)
   to see what actually changed.
2. Move it **up** the priority order — replace a CSS/XPath locator with a
   role/label/test-id one.
3. Fix the root cause (timing, ambiguity, wrong target). Do not add retries,
   widen timeouts blindly, or mark the scenario skipped to go green.
