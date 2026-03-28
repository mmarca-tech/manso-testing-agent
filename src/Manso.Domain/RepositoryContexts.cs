namespace Manso.Domain;

public sealed record RepositoryTarget(
    string Alias,
    string Provider,
    string Organization,
    string Project,
    string RepositoryName,
    string RepositoryUrl,
    string DefaultBranch,
    string? BranchName,
    string? BaseBranch,
    int? PullRequestId,
    string? PullRequestReference,
    string? SourceCommitSha,
    string? TargetCommitSha,
    string ResolutionEvidence)
{
    public IReadOnlyList<int> PullRequestIds { get; init; } = Array.Empty<int>();

    public IReadOnlyList<string> PullRequestReferences { get; init; } = Array.Empty<string>();
}

public sealed record RepositoryPullRequest(
    int PullRequestId,
    string PullRequestReference,
    string SourceBranch,
    string TargetBranch,
    string? SourceCommitSha,
    string? TargetCommitSha,
    string Status);

public sealed record RepositoryContextBundle(
    RepositoryTarget Target,
    RepositoryConventions Conventions,
    IReadOnlyList<RepositoryFileChange> ChangedFiles,
    IReadOnlyList<NeighboringTestFile> NeighboringTests,
    string CombinedDiff,
    IReadOnlyList<RunWarning> Warnings);

public sealed record RepositoryConventions(
    string AdapterAlias,
    bool SupportsExecutableTestGeneration,
    string TestFramework,
    string TargetFramework,
    IReadOnlyList<string> TestDirectoryRoots,
    IReadOnlyList<string> AllowedHelperDirectoryRoots,
    IReadOnlyList<string> ProtectedPathPrefixes,
    IReadOnlyList<string> BuildCommands,
    IReadOnlyList<string> TestCommands,
    IReadOnlyList<string> FormatterCommands,
    string TestFileSuffix);

public sealed record RepositoryFileChange(
    string Path,
    RepositoryChangeKind ChangeKind,
    bool IsTestFile,
    string? PreviousPath,
    string? DiffPreview);

public sealed record NeighboringTestFile(
    string Path,
    string MatchReason,
    string Content);

public enum RepositoryChangeKind
{
    Added,
    Modified,
    Deleted,
    Renamed,
}
