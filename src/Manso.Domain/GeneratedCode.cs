namespace Manso.Domain;

public sealed record GeneratedCodeBundle(
    IReadOnlyList<GeneratedFile> Files,
    string CoverageSummary,
    string RawModelOutput);

public sealed record GeneratedFile(
    string Path,
    string Content,
    GeneratedFileAction Action);

public enum GeneratedFileAction
{
    Create,
    Update,
}
