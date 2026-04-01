namespace Manso.Domain;

public sealed record XrayScenarioSyncItem(
    string ScenarioId,
    string Title,
    string Action,
    string? XrayIssueId,
    string? XrayIssueKey,
    string? Reason,
    string? LinkedRequirementIssueKey = null,
    string? TestSetIssueKey = null);
