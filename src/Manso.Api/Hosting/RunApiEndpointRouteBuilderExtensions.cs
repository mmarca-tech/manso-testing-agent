using Manso.Application;
using Manso.Domain;

namespace Manso.Api;

public static class RunApiEndpointRouteBuilderExtensions
{
    public static IEndpointRouteBuilder MapRunApi(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapHealthChecks("/health/live");
        endpoints.MapHealthChecks("/health/ready");

        endpoints.MapPost("/api/runs", StartRunAsync);
        endpoints.MapGet("/api/runs/{runId}", GetRunAsync);
        endpoints.MapGet("/api/runs/{runId}/artifacts", GetArtifactsAsync);
        endpoints.MapGet("/api/runs/{runId}/artifacts/{artifactName}", GetArtifactContentAsync);

        return endpoints;
    }

    private static async Task<IResult> StartRunAsync(
        RawRunRequest request,
        HttpContext httpContext,
        ITestGenerationRunService runService,
        CancellationToken ct)
    {
        var response = await runService.StartAsync(request, httpContext.GetCorrelationId(), ct);
        return Results.Accepted($"/api/runs/{response.RunId}", response);
    }

    private static async Task<IResult> GetRunAsync(
        string runId,
        ITestGenerationRunService runService,
        CancellationToken ct)
    {
        var run = await runService.GetAsync(runId, ct);
        return run is null
            ? Results.NotFound(CreateRunNotFound(runId))
            : Results.Ok(RunResponseMapper.Map(run));
    }

    private static async Task<IResult> GetArtifactsAsync(
        string runId,
        ITestGenerationRunService runService,
        CancellationToken ct)
    {
        var run = await runService.GetAsync(runId, ct);
        return run is null
            ? Results.NotFound(CreateRunNotFound(runId))
            : Results.Ok(RunResponseMapper.MapArtifacts(run));
    }

    private static async Task<IResult> GetArtifactContentAsync(
        string runId,
        string artifactName,
        ITestGenerationRunService runService,
        CancellationToken ct)
    {
        var run = await runService.GetAsync(runId, ct);
        if (run is null)
        {
            return Results.NotFound(CreateRunNotFound(runId));
        }

        var artifact = run.FindStoredArtifact(artifactName);
        return artifact is null
            ? Results.NotFound(CreateArtifactNotFound(runId, artifactName))
            : Results.Content(artifact.Content, artifact.ContentType);
    }

    private static ApiErrorResponse CreateRunNotFound(string runId)
        => new("RUN_NOT_FOUND", $"Run '{runId}' was not found.");

    private static ApiErrorResponse CreateArtifactNotFound(string runId, string artifactName)
        => new("ARTIFACT_NOT_FOUND", $"Artifact '{artifactName}' was not found for run '{runId}'.");
}
