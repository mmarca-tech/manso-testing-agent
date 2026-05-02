namespace Manso.Domain;

public sealed record GeneratedScenarioBundle(
    IReadOnlyList<GeneratedScenario> Scenarios,
    string ModelProvider,
    string ModelName,
    string RawJson)
{
    public LlmUsageMetrics? Usage { get; init; }

    public int ProviderRequestCount { get; init; }
}
