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
                stage.Details,
                stage.DurationMs,
                stage.Metrics)).ToArray(),
            run.Warnings.ToArray(),
            run.Errors.ToArray());

    public static RunArtifactsResponse MapArtifacts(TestGenerationRun run)
        => new(run.RunId, run.Artifacts.ToArray());
}
