using Manso.Domain;

namespace Manso.Api;

public sealed record RunDetailsResponse(
    string RunId,
    string IssueKey,
    RunStatus Status,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset? StartedAtUtc,
    DateTimeOffset? CompletedAtUtc,
    string? Repository,
    string? PullRequestReference,
    IReadOnlyList<string> PullRequestReferences,
    IReadOnlyList<RunStageResponse> Stages,
    IReadOnlyList<RunWarning> Warnings,
    IReadOnlyList<RunError> Errors);
