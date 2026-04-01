namespace Manso.Domain;

public sealed record XrayTestCaseUpsertRequest(
    string ProjectKey,
    string Summary,
    string Description,
    string TestType,
    string? Gherkin,
    IReadOnlyList<XrayTestStep> Steps,
    IReadOnlyList<string> Labels,
    string? ExistingIssueId);
