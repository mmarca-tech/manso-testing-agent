namespace Manso.Domain;

public sealed record OutputWriteResult(
    WriteResult Result,
    IReadOnlyList<StoredArtifact> Artifacts);
