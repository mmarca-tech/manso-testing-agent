using System.Text.Json;
using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging.Abstractions;

namespace Manso.UnitTests;

public sealed class OutputWriterTests
{
    [Fact]
    public async Task WriteAsync_CreatesScenarioMarkdownAndWriteResultArtifacts()
    {
        var writer = new OutputWriter(new StubScmClient(), NullLogger<OutputWriter>.Instance);

        var result = await writer.WriteAsync(
            CreateBundle(),
            CreateScenarios(),
            null,
            new ValidationResult(ValidationOutcome.Pass, Array.Empty<ValidationMessage>()),
            CancellationToken.None);

        Assert.Contains(result.Artifacts, artifact => artifact.Type == "ScenarioMarkdown");
        Assert.Contains(result.Artifacts, artifact => artifact.Type == "WriteResultJson");

        var markdown = result.Artifacts.Single(artifact => artifact.Type == "ScenarioMarkdown");
        Assert.Contains("Scenario: Retry transient callback failure", markdown.Content);

        var writeResult = JsonSerializer.Deserialize<WriteResult>(
            result.Artifacts.Single(artifact => artifact.Type == "WriteResultJson").Content,
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.NotNull(writeResult);
        Assert.Equal("ArtifactsStoredNoRepoWrite", writeResult.Status);
    }

    [Fact]
    public async Task WriteAsync_CreatesWritePlanAndDraftPullRequest_WhenExecutableOutputIsEligible()
    {
        var scmClient = new StubScmClient();
        var writer = new OutputWriter(scmClient, NullLogger<OutputWriter>.Instance);

        var result = await writer.WriteAsync(
            CreateBundle(GenerationMode.ExecutableTests, OutputTarget.DraftPullRequest),
            CreateScenarios(),
            new GeneratedCodeBundle(
                [
                    new GeneratedFile(
                        "/tests/Callbacks/RetryHandlerTests.cs",
                        "public sealed class RetryHandlerTests { }",
                        GeneratedFileAction.Create),
                ],
                "Covers retry success and terminal-failure handling.",
                "{}"),
            new ValidationResult(ValidationOutcome.Pass, Array.Empty<ValidationMessage>()),
            CancellationToken.None);

        Assert.Equal("DraftPullRequestCreated", result.Result.Status);
        Assert.Equal("ai-testgen/QA-1234/retry-transient-callback-tests", result.Result.BranchName);
        Assert.Equal("https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/999", result.Result.PullRequestUrl);
        Assert.Contains(result.Artifacts, artifact => artifact.Type == "GeneratedCodeBundleJson");
        Assert.Contains(result.Artifacts, artifact => artifact.Type == "RepositoryWritePlanJson");
        Assert.NotNull(scmClient.LastPlan);
        Assert.Equal("test(ai): generate tests for QA-1234", scmClient.LastPlan!.CommitMessage);
    }

    private static GenerationContextBundle CreateBundle(
        GenerationMode generationMode = GenerationMode.TestCasesOnly,
        OutputTarget outputTarget = OutputTarget.Both)
    {
        var repositoryTarget = new RepositoryTarget(
            "bank-otp-api",
            "AzureDevOps",
            "afs-dev",
            "rps",
            "bank-otp-api",
            "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api",
            "main",
            "feature/qa-1234",
            "main",
            882,
            "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/882",
            "source-sha",
            "target-sha",
            "jira_development_pull_request");

        return new(
            new RunMetadataContext(
                "QA-1234",
                generationMode,
                TestScope.Api,
                CoverageIntent.Regression,
                outputTarget,
                "bank-otp-api",
                "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/882",
                repositoryTarget),
            Array.Empty<GenerationContextSection>(),
            Array.Empty<RunWarning>(),
            0,
            0,
            0,
            0);
    }

    private static GeneratedScenarioBundle CreateScenarios()
        => new(
            [
                new GeneratedScenario(
                    "SCN-001",
                    "Retry transient callback",
                    "High",
                    "Api",
                    ["AC-1"],
                    "Retry behavior changed.",
                    ["Callback exists"],
                    "Scenario: Retry transient callback failure",
                    "Callback is retried successfully",
                    "No duplicate found"),
            ],
            "Mock",
            "mock-model",
            "{}");

    private sealed class StubScmClient : IScmClient
    {
        public RepositoryWritePlan? LastPlan { get; private set; }

        public Task<RepositoryPullRequest> GetPullRequestAsync(
            RepositoryTarget repository,
            int pullRequestId,
            CancellationToken ct)
            => throw new NotSupportedException();

        public Task<RepositoryContextBundle> GetCodeContextAsync(
            RepositoryTarget target,
            RepositoryRetrievalOptions options,
            RepositoryConventions conventions,
            CancellationToken ct)
            => throw new NotSupportedException();

        public Task<RepositoryWriteExecutionResult> WriteAsync(
            RepositoryTarget target,
            RepositoryWritePlan plan,
            CancellationToken ct)
        {
            LastPlan = plan;
            return Task.FromResult(new RepositoryWriteExecutionResult(
                plan.NewBranchName,
                "commit-sha-123",
                "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/999"));
        }
    }
}
