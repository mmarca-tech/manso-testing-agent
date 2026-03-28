namespace Manso.Domain;

public sealed record XrayContextBundle(
    IReadOnlyList<XrayTestCase> NeighboringTests,
    IReadOnlyList<RunWarning> Warnings);

public sealed record XrayTestCase(
    string IssueId,
    string IssueKey,
    string Summary,
    string TestType,
    string? Gherkin,
    IReadOnlyList<XrayTestStep> Steps,
    IReadOnlyList<string> Labels);

public sealed record XrayTestStep(
    string Action,
    string? Data,
    string? Result);

public sealed record XrayTestSearchRequest(
    string Jql,
    int Limit);

public sealed record XrayTestCaseUpsertRequest(
    string ProjectKey,
    string Summary,
    string Description,
    string TestType,
    string? Gherkin,
    IReadOnlyList<XrayTestStep> Steps,
    IReadOnlyList<string> Labels,
    string? ExistingIssueId);

public sealed record XrayTestCaseUpsertResult(
    string IssueId,
    string IssueKey,
    bool Created);

public sealed record XrayTestExecutionUploadRequest(
    string ProjectKey,
    string Summary,
    IReadOnlyList<XrayTestExecutionResultItem> Results,
    IReadOnlyList<string> TestPlanIssueIds,
    IReadOnlyList<string> TestSetIssueIds);

public sealed record XrayTestExecutionResultItem(
    string TestIssueId,
    string Status,
    string? Comment,
    string? EvidenceFileName,
    string? EvidenceBase64);

public sealed record XrayTestExecutionUploadResult(
    string TestExecutionIssueId,
    string TestExecutionIssueKey);

public sealed record XrayAssociationUpdateRequest(
    string ContainerIssueId,
    IReadOnlyList<string> TestIssueIds);

public sealed record XrayScenarioSyncResult(
    IReadOnlyList<XrayScenarioSyncItem> Items,
    IReadOnlyList<RunWarning> Warnings);

public sealed record XrayScenarioSyncItem(
    string ScenarioId,
    string Title,
    string Action,
    string? XrayIssueId,
    string? XrayIssueKey,
    string? Reason);
