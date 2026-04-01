namespace Manso.Domain;

public sealed record JiraLinkedIssue(
    string IssueKey,
    string IssueType,
    string? Summary,
    string? LinkTypeName,
    string Direction);
