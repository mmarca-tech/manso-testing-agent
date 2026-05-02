namespace Manso.Domain;

public sealed record XrayContextBundle(
    IReadOnlyList<XrayTestCase> NeighboringTests,
    IReadOnlyList<RunWarning> Warnings)
{
    public int ProviderRequestCount { get; init; }
}
