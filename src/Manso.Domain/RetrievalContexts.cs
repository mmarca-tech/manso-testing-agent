namespace Manso.Domain;

public sealed record JiraIssueContext(
    string IssueKey,
    string Summary,
    string Description,
    string? AcceptanceCriteria,
    string IssueType,
    string? Priority,
    IReadOnlyList<JiraCommentContext> Comments,
    IReadOnlyList<string> LinkedIssueKeys,
    IReadOnlyList<string> Labels,
    IReadOnlyList<JiraDevelopmentRepository> DevelopmentRepositories);

public sealed record JiraCommentContext(
    string CommentId,
    string? AuthorDisplayName,
    string Body,
    DateTimeOffset? CreatedAtUtc);

public sealed record JiraDevelopmentRepository(
    string Name,
    string? Url,
    IReadOnlyList<JiraDevelopmentBranch> Branches,
    IReadOnlyList<JiraDevelopmentPullRequest> PullRequests);

public sealed record JiraDevelopmentBranch(
    string Name,
    string? Url,
    string? CreatePullRequestUrl);

public sealed record JiraDevelopmentPullRequest(
    string Url,
    string? Status,
    string? BranchName,
    string? DestinationBranchName,
    DateTimeOffset? LastUpdatedUtc);

public sealed record ConfluenceDocument(
    string SourceUrl,
    string PageId,
    string Title,
    string SpaceKey,
    int Version,
    DateTimeOffset? LastModifiedUtc,
    IReadOnlyList<ConfluenceChunk> Chunks);

public sealed record ConfluenceChunk(
    string ChunkId,
    string HeadingPath,
    string Text,
    int EstimatedTokens);
