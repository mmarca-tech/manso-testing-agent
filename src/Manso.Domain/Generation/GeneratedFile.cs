namespace Manso.Domain;

public sealed record GeneratedFile(
    string Path,
    string Content,
    GeneratedFileAction Action);
