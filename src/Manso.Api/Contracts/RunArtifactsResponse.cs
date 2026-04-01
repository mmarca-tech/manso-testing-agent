using Manso.Domain;

namespace Manso.Api;

public sealed record RunArtifactsResponse(
    string RunId,
    IReadOnlyList<ArtifactReference> Artifacts);
