namespace Manso.Domain;

public sealed record NormalizedRunRequest(
    string IssueKey,
    WorkflowPass WorkflowPass,
    TestScope TestScope,
    string? RepositoryAlias,
    string RequestedBy);
