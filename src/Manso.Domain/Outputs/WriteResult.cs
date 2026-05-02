namespace Manso.Domain;

public sealed record WriteResult(
    string Status,
    IReadOnlyList<ArtifactReference> Artifacts);
