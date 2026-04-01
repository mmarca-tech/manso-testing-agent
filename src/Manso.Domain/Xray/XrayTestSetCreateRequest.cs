namespace Manso.Domain;

public sealed record XrayTestSetCreateRequest(
    string ProjectKey,
    string Summary,
    string Description,
    IReadOnlyList<string> Labels);
