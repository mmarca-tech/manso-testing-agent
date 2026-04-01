namespace Manso.Domain;

public sealed record JiraCommentContext(
    string CommentId,
    string? AuthorDisplayName,
    string Body,
    DateTimeOffset? CreatedAtUtc);
