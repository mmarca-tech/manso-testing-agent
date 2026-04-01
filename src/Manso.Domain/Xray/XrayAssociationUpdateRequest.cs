namespace Manso.Domain;

public sealed record XrayAssociationUpdateRequest(
    string ContainerIssueId,
    IReadOnlyList<string> TestIssueIds);
