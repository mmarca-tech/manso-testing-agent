namespace Manso.Domain;

public sealed record XrayScenarioSyncResult(
    IReadOnlyList<XrayScenarioSyncItem> Items,
    IReadOnlyList<RunWarning> Warnings);
