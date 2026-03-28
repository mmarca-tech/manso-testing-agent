namespace Manso.Domain;

public sealed record GeneratedScenarioBundle(
    IReadOnlyList<GeneratedScenario> Scenarios,
    string ModelProvider,
    string ModelName,
    string RawJson);

public sealed record GeneratedScenario(
    string ScenarioId,
    string Title,
    string Priority,
    string SuggestedLevel,
    IReadOnlyList<string> SourceAcceptanceCriteriaRefs,
    string RiskRationale,
    IReadOnlyList<string> Preconditions,
    string Gherkin,
    string ExpectedOutcome,
    string DuplicateAssessment);
