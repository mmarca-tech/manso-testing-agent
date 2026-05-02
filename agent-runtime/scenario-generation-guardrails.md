# Scenario Generation Guardrails

Use this file when implementing or running scenario design, evidence retrieval,
validation, artifact creation, Xray synchronization, or idempotency/rerun
control.

## Runtime rules

- Treat Jira development metadata as the only authoritative repository-context
  source for iteration 1.
- Do not introduce manual branch or PR override as a competing runtime path.
- Preserve the current multi-PR aggregation policy for the configured
  repository.
- Keep scenario artifacts Gherkin-first for reviewability.
- Persist machine-readable artifacts for scenarios, validation, and write
  results.
- Implement duplicate-run protection before enabling overlapping runs for the
  same issue, workflow pass, and repository.

## Implementation stance

- Encode behavior in code contracts and tests, not only in prose.
- Keep repo-specific behavior behind adapters.
- Fail loudly on ambiguous or unsupported scenarios.
- Do not silently widen file scope, repo scope, or retrieval scope.
- If a rule is important enough to mention here, it should usually also be
  reflected in a unit or integration test.
