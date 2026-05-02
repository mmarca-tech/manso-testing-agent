namespace Manso.Domain;

public sealed record RawRunRequest(
    string? WorkflowPass,
    string? IssueKey,
    string? RequestedBy);
