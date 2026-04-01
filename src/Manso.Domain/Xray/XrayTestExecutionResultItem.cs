namespace Manso.Domain;

public sealed record XrayTestExecutionResultItem(
    string TestIssueId,
    string Status,
    string? Comment,
    string? EvidenceFileName,
    string? EvidenceBase64);
