using Manso.Domain;

namespace Manso.Api;

public sealed record RunStageResponse(
    RunStageName Name,
    RunStageStatus Status,
    DateTimeOffset StartedAtUtc,
    DateTimeOffset? CompletedAtUtc,
    string? Details,
    long? DurationMs,
    IReadOnlyDictionary<string, string> Metrics);
