namespace Manso.Domain;

public sealed record XrayTestCaseUpsertResult(
    string IssueId,
    string IssueKey,
    bool Created);
