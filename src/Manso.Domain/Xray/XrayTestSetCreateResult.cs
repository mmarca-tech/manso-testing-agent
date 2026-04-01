namespace Manso.Domain;

public sealed record XrayTestSetCreateResult(
    string IssueId,
    string IssueKey,
    bool Created);
