namespace Manso.Domain;

public sealed record XrayTestExecutionUploadRequest(
    string ProjectKey,
    string Summary,
    IReadOnlyList<XrayTestExecutionResultItem> Results,
    IReadOnlyList<string> TestPlanIssueIds,
    IReadOnlyList<string> TestSetIssueIds);
