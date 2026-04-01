namespace Manso.Domain;

public sealed record ConfluenceChunk(
    string ChunkId,
    string HeadingPath,
    string Text,
    int EstimatedTokens);
