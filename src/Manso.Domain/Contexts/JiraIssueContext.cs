namespace Manso.Domain;

public sealed record JiraIssueContext(
    string IssueKey,
    string Summary,
    string Description,
    string? AcceptanceCriteria,
    string IssueType,
    string? Priority,
    IReadOnlyList<JiraCommentContext> Comments,
    IReadOnlyList<JiraLinkedIssue> LinkedIssues,
    IReadOnlyList<string> LinkedIssueKeys,
    IReadOnlyList<string> Labels,
    IReadOnlyList<JiraDevelopmentRepository> DevelopmentRepositories)
{
    public IReadOnlyList<JiraReferencedIssueContext> DescriptionReferencedIssues { get; init; } = Array.Empty<JiraReferencedIssueContext>();
}
