namespace Manso.Domain;

public sealed record GenerationContextBundle(
    RunMetadataContext Metadata,
    IReadOnlyList<GenerationContextSection> Sections,
    IReadOnlyList<RunWarning> Warnings,
    int DocumentationDocumentCount,
    int ChangedFileCount,
    int NeighboringTestCount,
    int XrayNeighboringTestCount);

public sealed record RunMetadataContext(
    string IssueKey,
    GenerationMode GenerationMode,
    TestScope TestScope,
    CoverageIntent CoverageIntent,
    OutputTarget OutputTarget,
    string? RepositoryAlias,
    string? PullRequestReference,
    RepositoryTarget? RepositoryTarget);

public sealed record GenerationContextSection(
    string Key,
    string Title,
    string Content);
