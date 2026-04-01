namespace Manso.Domain;

public sealed record GenerationContextBundle(
    RunMetadataContext Metadata,
    IReadOnlyList<GenerationContextSection> Sections,
    IReadOnlyList<RunWarning> Warnings,
    int DocumentationDocumentCount,
    int ChangedFileCount,
    int NeighboringTestCount,
    int XrayNeighboringTestCount);
