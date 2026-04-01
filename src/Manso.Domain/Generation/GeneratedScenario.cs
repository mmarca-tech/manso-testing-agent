namespace Manso.Domain;

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
    string DuplicateAssessment,
    string? ExistingXrayIssueKey = null);
