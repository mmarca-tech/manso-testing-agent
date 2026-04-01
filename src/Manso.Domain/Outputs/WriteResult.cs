namespace Manso.Domain;

public sealed record WriteResult(
    OutputTarget Target,
    string Status,
    string? BranchName,
    string? PullRequestUrl,
    IReadOnlyList<ArtifactReference> Artifacts);
