namespace Manso.Domain;

public sealed record RepositoryWritePlan(
    string RepositoryAlias,
    string BaseBranch,
    string NewBranchName,
    string CommitMessage,
    IReadOnlyList<GeneratedFile> Files,
    string PullRequestTitle,
    string PullRequestBody,
    bool CreateDraftPullRequest);
