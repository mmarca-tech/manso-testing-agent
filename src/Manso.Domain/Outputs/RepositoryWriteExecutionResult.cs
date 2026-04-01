namespace Manso.Domain;

public sealed record RepositoryWriteExecutionResult(
    string BranchName,
    string CommitId,
    string? PullRequestUrl);
