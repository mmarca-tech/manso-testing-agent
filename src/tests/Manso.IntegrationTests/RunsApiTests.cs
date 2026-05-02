using Manso.Api;
using Manso.Application;
using Manso.Domain;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Manso.IntegrationTests;

public sealed class RunsApiTests : IClassFixture<MansoApiFactory>
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    private readonly HttpClient _client;

    public RunsApiTests(MansoApiFactory factory)
    {
        _client = factory.CreateClient();
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "test-token");
    }

    [Fact]
    public async Task PostRuns_ReturnsAccepted_AndBackgroundExecutionCompletes()
    {
        var request = CreateRequest();

        var response = await _client.PostAsJsonAsync("/api/runs", request);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.True(response.Headers.Contains(CorrelationIdMiddleware.CorrelationIdHeaderName));

        var accepted = await response.Content.ReadFromJsonAsync<RunAcceptedResponse>(JsonOptions);
        Assert.NotNull(accepted);
        Assert.Equal(RunStatus.Queued, accepted.Status);

        var run = await WaitForCompletionAsync(accepted.RunId);
        Assert.Equal(RunStatus.Succeeded, run.Status);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.RequestAccepted && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.RequestNormalized && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.JiraContextCollected && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.ConfluenceResolved && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.RepositoryResolved && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.CodeContextCollected && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.XrayContextCollected && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.ContextBundleBuilt && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.ScenariosGenerated && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.TestsGenerated && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.OutputsValidated && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.OutputsWritten && stage.Status == RunStageStatus.Succeeded);
        Assert.Equal("SomeRepo", run.Repository);
        Assert.Equal("https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/882", run.PullRequestReference);
        Assert.Equal(
            ["https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/882"],
            run.PullRequestReferences);

        var rawRunResponse = await _client.GetAsync($"/api/runs/{accepted.RunId}");
        rawRunResponse.EnsureSuccessStatusCode();
        var rawRunJson = await rawRunResponse.Content.ReadAsStringAsync();
        Assert.Contains("\"status\":\"Succeeded\"", rawRunJson);
        Assert.Contains("\"name\":\"RequestAccepted\"", rawRunJson);

        var artifactsResponse = await _client.GetAsync($"/api/runs/{accepted.RunId}/artifacts");
        artifactsResponse.EnsureSuccessStatusCode();

        var artifacts = await artifactsResponse.Content.ReadFromJsonAsync<RunArtifactsResponse>(JsonOptions);
        Assert.NotNull(artifacts);
        Assert.Contains(artifacts.Artifacts, artifact => artifact.Type == "ScenarioJson");
        Assert.Contains(artifacts.Artifacts, artifact => artifact.Type == "ScenarioMarkdown");
        Assert.Contains(artifacts.Artifacts, artifact => artifact.Type == "ValidationReportJson");
        Assert.Contains(artifacts.Artifacts, artifact => artifact.Type == "WriteResultJson");

        var markdownResponse = await _client.GetAsync($"/api/runs/{accepted.RunId}/artifacts/generated-scenarios.md");
        markdownResponse.EnsureSuccessStatusCode();
        var markdown = await markdownResponse.Content.ReadAsStringAsync();
        Assert.Contains("# Scenario Output for QA-1234", markdown);

        var writeResultResponse = await _client.GetAsync($"/api/runs/{accepted.RunId}/artifacts/write-result.json");
        writeResultResponse.EnsureSuccessStatusCode();
        var writeResultJson = await writeResultResponse.Content.ReadAsStringAsync();
        Assert.Contains("ScenarioArtifactsStored", writeResultJson);
    }

    [Fact]
    public async Task PostRuns_ReturnsUnauthorized_WhenBearerTokenIsMissing()
    {
        await using var factory = new MansoApiFactory();
        using var client = factory.CreateClient();

        var response = await client.PostAsJsonAsync("/api/runs", CreateRequest());

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task PostRuns_ReturnsBadRequest_WhenWorkflowPassIsUnsupported()
    {
        var request = CreateRequest(workflowPass: "DoEverything");

        var response = await _client.PostAsJsonAsync("/api/runs", request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

        var error = await response.Content.ReadFromJsonAsync<ApiErrorResponse>(JsonOptions);
        Assert.NotNull(error);
        Assert.Equal("INVALID_REQUEST", error.ErrorCode);
        Assert.Contains("not supported", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task PostRuns_SkipsRepositoryStages_WhenNoPrOrBranchContextExists()
    {
        var request = CreateRequest(
            issueKey: "QA-NOPR");

        var response = await _client.PostAsJsonAsync("/api/runs", request);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);

        var accepted = await response.Content.ReadFromJsonAsync<RunAcceptedResponse>(JsonOptions);
        Assert.NotNull(accepted);

        var run = await WaitForCompletionAsync(accepted.RunId);
        Assert.Equal(RunStatus.Succeeded, run.Status);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.RepositoryResolved && stage.Status == RunStageStatus.Skipped);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.CodeContextCollected && stage.Status == RunStageStatus.Skipped);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.ContextBundleBuilt && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.XrayContextCollected && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.ScenariosGenerated && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.TestsGenerated && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.OutputsValidated && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.OutputsWritten && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Warnings, warning => warning.Code == "repository_context_unavailable");
    }

    [Fact]
    public async Task PostRuns_UsesAggregatedRepositoryStages_ForScenarioDesign_WhenMultipleMergedPrsExist()
    {
        var request = CreateRequest(
            issueKey: "QA-MULTIPR",
            workflowPass: "ScenarioDesign");

        var response = await _client.PostAsJsonAsync("/api/runs", request);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);

        var accepted = await response.Content.ReadFromJsonAsync<RunAcceptedResponse>(JsonOptions);
        Assert.NotNull(accepted);

        var run = await WaitForCompletionAsync(accepted.RunId);
        Assert.Equal(RunStatus.Succeeded, run.Status);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.RepositoryResolved && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.CodeContextCollected && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.XrayContextCollected && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.ScenariosGenerated && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.TestsGenerated && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.OutputsValidated && stage.Status == RunStageStatus.Succeeded);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.OutputsWritten && stage.Status == RunStageStatus.Succeeded);
        Assert.DoesNotContain(run.Warnings, warning => warning.Code == "repository_context_unavailable");
        Assert.Equal(
            [
                "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/881",
                "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/882",
            ],
            run.PullRequestReferences);
    }

    [Fact]
    public async Task PostRuns_AutoCreatesOrUpdatesXrayTests_ForScenarioDesignTestCasesOnly()
    {
        var request = CreateRequest(
            workflowPass: "ScenarioDesign");

        var response = await _client.PostAsJsonAsync("/api/runs", request);
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);

        var accepted = await response.Content.ReadFromJsonAsync<RunAcceptedResponse>(JsonOptions);
        Assert.NotNull(accepted);

        var run = await WaitForCompletionAsync(accepted.RunId);
        Assert.Equal(RunStatus.Succeeded, run.Status);
        Assert.Contains(run.Stages, stage => stage.Name == RunStageName.TestsGenerated && stage.Status == RunStageStatus.Succeeded);

        var syncArtifactResponse = await _client.GetAsync($"/api/runs/{accepted.RunId}/artifacts/xray-sync-result.json");
        syncArtifactResponse.EnsureSuccessStatusCode();
        var syncArtifactJson = await syncArtifactResponse.Content.ReadAsStringAsync();
        Assert.Contains("\"Action\":\"Updated\"", syncArtifactJson);
    }

    private Task<RunDetailsResponse> WaitForCompletionAsync(string runId)
        => WaitForCompletionAsync(_client, runId);

    private static async Task<RunDetailsResponse> WaitForCompletionAsync(HttpClient client, string runId)
    {
        for (var attempt = 0; attempt < 50; attempt++)
        {
            var response = await client.GetAsync($"/api/runs/{runId}");
            response.EnsureSuccessStatusCode();

            var run = await response.Content.ReadFromJsonAsync<RunDetailsResponse>(JsonOptions);
            Assert.NotNull(run);

            if (run.Status is RunStatus.Succeeded or RunStatus.Failed or RunStatus.PartialSuccess or RunStatus.Cancelled)
            {
                return run;
            }

            await Task.Delay(100);
        }

        throw new TimeoutException($"Run '{runId}' did not complete within the expected time.");
    }

    private static RawRunRequest CreateRequest(
        string issueKey = "QA-1234",
        string workflowPass = "ScenarioDesign")
        => new(
            workflowPass,
            issueKey,
            "abc-123");
}
