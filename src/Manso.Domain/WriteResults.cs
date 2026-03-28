namespace Manso.Domain;

public sealed record WriteResult(
    OutputTarget Target,
    string Status,
    string? BranchName,
    string? PullRequestUrl,
    IReadOnlyList<ArtifactReference> Artifacts);

public sealed record RepositoryWritePlan(
    string RepositoryAlias,
    string BaseBranch,
    string NewBranchName,
    string CommitMessage,
    IReadOnlyList<GeneratedFile> Files,
    string PullRequestTitle,
    string PullRequestBody,
    bool CreateDraftPullRequest);

public sealed record RepositoryWriteExecutionResult(
    string BranchName,
    string CommitId,
    string? PullRequestUrl);

public sealed record OutputWriteResult(
    WriteResult Result,
    IReadOnlyList<StoredArtifact> Artifacts);
