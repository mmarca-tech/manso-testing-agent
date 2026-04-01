namespace Manso.Domain;

public sealed record XrayTestCase(
    string IssueId,
    string IssueKey,
    string Summary,
    string TestType,
    string? Gherkin,
    IReadOnlyList<XrayTestStep> Steps,
    IReadOnlyList<string> Labels);
