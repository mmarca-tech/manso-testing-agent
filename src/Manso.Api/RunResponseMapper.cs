using Manso.Domain;

namespace Manso.Api;

public static class RunResponseMapper
{
    public static RunDetailsResponse Map(TestGenerationRun run)
        => new(
            run.RunId,
            run.IssueKey,
            run.Status,
            run.CreatedAtUtc,
            run.StartedAtUtc,
            run.CompletedAtUtc,
            run.RepositoryAlias,
            run.PullRequestReference,
            run.PullRequestReferences.ToArray(),
            run.Stages.Select(stage => new RunStageResponse(
                stage.Name,
                stage.Status,
                stage.StartedAtUtc,
                stage.CompletedAtUtc,
                stage.Details)).ToArray(),
            run.Warnings.ToArray(),
            run.Errors.ToArray());

    public static RunArtifactsResponse MapArtifacts(TestGenerationRun run)
        => new(run.RunId, run.Artifacts.ToArray());
}

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

public sealed record RunStageResponse(
    RunStageName Name,
    RunStageStatus Status,
    DateTimeOffset StartedAtUtc,
    DateTimeOffset? CompletedAtUtc,
    string? Details);

public sealed record RunArtifactsResponse(
    string RunId,
    IReadOnlyList<ArtifactReference> Artifacts);
