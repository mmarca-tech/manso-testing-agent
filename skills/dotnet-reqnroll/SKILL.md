---
name: dotnet-reqnroll
description: Implement Gherkin step definitions in .NET with Reqnroll (the maintained SpecFlow successor).
appliesTo: { stacks: [dotnet-reqnroll], phase: implementation }
when: Use when the repo runs Reqnroll with xUnit/NUnit/MSTest.
---

# Reqnroll Implementation Guidance

This stack binds Gherkin scenarios to .NET code through Reqnroll. Treat the
`.feature` files as the source of truth; only edit them when the design
itself changes.

## Where things live

- **Feature files**: `<root>/<featureGlob>` from `.agents/manso.config.json`,
  typically `**/Features/**/*.feature`.
- **Step definitions**: `Steps/` or `StepDefinitions/` folder next to the
  features. Follow the existing project layout.
- **Hooks**: `Hooks/` folder with `[BeforeScenario]` / `[AfterScenario]`.
- **Test data / fixtures**: existing builders, `Specflow.Plus` config, or
  test-data classes in the project — reuse them.
- **DI / context**: use Reqnroll's `ScenarioContext` for per-scenario data
  and DI registration that the project already declares.

## Implementation contract

- One Reqnroll step definition (`[Given]` / `[When]` / `[Then]`) per Gherkin
  step text. Reuse where a matching binding already exists.
- Step methods stay thin: orchestrate, do not assert business logic. Use the
  project's assertion library (FluentAssertions / xUnit `Assert`) inside
  `Then` steps.
- Prefer async/await over `.Result` or `.Wait()` — never block on async.
- Avoid `Thread.Sleep`. Use polling with `Awaiter`-style helpers the project
  already provides, or wait on observable state.
- Test data: pull from existing factories / object mothers. Never hardcode
  tenant ids, account ids, or production URLs.
- Logging: respect the project's `IReqnrollOutputHelper` or `ITestOutputHelper`
  conventions; do not write directly to `Console`.

## Validation

Run the stack's `verifyCommand` (default `dotnet test`) when changes are
complete. To narrow, filter by trait/tag: `dotnet test --filter Category=story-<KEY>`.

## Anti-patterns

- Marking a scenario `[Ignore]` to make it green.
- Catching exceptions inside step definitions to swallow failures.
- Static state shared between scenarios — leads to flakiness.
- Adding `Task.Delay` to mask race conditions.
