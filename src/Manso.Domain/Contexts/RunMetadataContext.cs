namespace Manso.Domain;

public sealed record RunMetadataContext(
    string IssueKey,
    GenerationMode GenerationMode,
    TestScope TestScope,
    CoverageIntent CoverageIntent,
    OutputTarget OutputTarget,
    string? RepositoryAlias,
    string? PullRequestReference,
    RepositoryTarget? RepositoryTarget);
