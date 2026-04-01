namespace Manso.Domain;

public sealed record GeneratedCodeBundle(
    IReadOnlyList<GeneratedFile> Files,
    string CoverageSummary,
    string RawModelOutput);
