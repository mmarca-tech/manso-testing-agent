# Executable Generation Guardrails

Use this file when implementing any of the following:

- repo adapters
- executable test generation
- validation-before-write
- artifact retrieval
- branch or draft-PR writeback
- idempotency or rerun control

Read `implementation-plan/08-executable-generation-contract.md` first.

## Runtime rules

- Treat Jira development metadata as the only authoritative repository-context
  source for iteration 1.
- Do not introduce manual branch or PR override as a competing runtime path.
- Preserve the current multi-PR aggregation policy for the configured
  repository.
- Keep scenario artifacts Gherkin-first even if executable matching later uses
  scenario ID or title.
- Prefer additive test files and minimal edits.
- Do not modify production code as part of executable generation.
- Validation must pass before any branch, commit, or PR write.
- Persist machine-readable artifacts for scenarios, generated code, validation,
  and write results.
- Implement duplicate-run protection before enabling overlapping write-capable
  runs.

## Implementation stance

- Encode behavior in code contracts and tests, not only in prose.
- Keep repo-specific behavior behind adapters.
- Fail loudly on ambiguous or unsupported write scenarios.
- Do not silently widen file scope, repo scope, or retrieval scope.
- If a rule is important enough to mention here, it should usually also be
  reflected in a unit or integration test.
