namespace Manso.Domain;

public sealed record GeneratedScenarioBundle(
    IReadOnlyList<GeneratedScenario> Scenarios,
    string ModelProvider,
    string ModelName,
    string RawJson);
