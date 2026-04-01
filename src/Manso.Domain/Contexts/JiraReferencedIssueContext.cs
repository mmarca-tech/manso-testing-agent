namespace Manso.Domain;

public sealed record JiraReferencedIssueContext(
    string IssueKey,
    string Summary,
    string Description);
