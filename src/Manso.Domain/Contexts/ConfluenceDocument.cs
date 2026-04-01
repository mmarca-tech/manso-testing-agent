namespace Manso.Domain;

public sealed record ConfluenceDocument(
    string SourceUrl,
    string PageId,
    string Title,
    string SpaceKey,
    int Version,
    DateTimeOffset? LastModifiedUtc,
    IReadOnlyList<ConfluenceChunk> Chunks);
