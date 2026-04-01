using Manso.Domain;

namespace Manso.UnitTests;

public sealed class TestGenerationRunDomainTests
{
    [Fact]
    public void WithNormalizedRequest_Throws_WhenIssueKeyDoesNotMatchRun()
    {
        var run = CreateRun();

        var exception = Assert.Throws<InvalidOperationException>(() => run.WithNormalizedRequest(
            new NormalizedRunRequest(
                "RM-999",
                GenerationMode.TestCasesOnly,
                WorkflowPass.ScenarioDesign,
                TestScope.Api,
                null,
                [],
                CoverageIntent.Regression,
                OutputTarget.JiraComment,
                new RequestedBy(null, "Tester", null),
                DocumentationMode.ExplicitOnly)));

        Assert.Contains("does not match run issue key", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void MarkCompleted_Throws_WhenStatusIsNotTerminal()
    {
        var run = CreateRun().MarkRunning(DateTimeOffset.Parse("2026-03-31T10:05:00Z"));

        var exception = Assert.Throws<InvalidOperationException>(() =>
            run.MarkCompleted(RunStatus.Running, DateTimeOffset.Parse("2026-03-31T10:06:00Z")));

        Assert.Contains("terminal status", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void MarkRunning_Throws_WhenRunIsAlreadyCompleted()
    {
        var run = CreateRun()
            .MarkRunning(DateTimeOffset.Parse("2026-03-31T10:05:00Z"))
            .MarkCompleted(RunStatus.Succeeded, DateTimeOffset.Parse("2026-03-31T10:06:00Z"));

        var exception = Assert.Throws<InvalidOperationException>(() =>
            run.MarkRunning(DateTimeOffset.Parse("2026-03-31T10:07:00Z")));

        Assert.Contains("cannot transition to Running", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AddWarning_DeduplicatesIdenticalWarnings()
    {
        var warning = new RunWarning("duplicate_warning", "Same warning.");

        var run = CreateRun()
            .AddWarning(warning)
            .AddWarning(warning);

        Assert.Single(run.Warnings);
    }

    [Fact]
    public void AddArtifact_ReplacesArtifactWithSameName()
    {
        var run = CreateRun()
            .AddArtifact(new ArtifactReference("json", "context.json", "application/json", 12, "run://context.json"))
            .AddArtifact(new ArtifactReference("json", "context.json", "application/json", 20, "run://context-v2.json"));

        var artifact = Assert.Single(run.Artifacts);
        Assert.Equal(20, artifact.SizeBytes);
        Assert.Equal("run://context-v2.json", artifact.Location);
    }

    [Fact]
    public void WithRepositoryTarget_UsesEffectivePullRequestReferences()
    {
        var target = new RepositoryTarget(
            "repo",
            "AzureDevOps",
            "afs-dev",
            "risk",
            "repo",
            "https://dev.azure.com/afs-dev/risk/_git/repo",
            "main",
            "feature/rm-1",
            "main",
            null,
            null,
            null,
            null,
            "jira")
        {
            PullRequestReferences =
            [
                "https://dev.azure.com/afs-dev/risk/_git/repo/pullrequest/1",
                "https://dev.azure.com/afs-dev/risk/_git/repo/pullrequest/2",
            ],
        };

        var run = CreateRun().WithRepositoryTarget(target);

        Assert.Equal(target.PullRequestReferences[0], run.PullRequestReference);
        Assert.Equal(2, run.PullRequestReferences.Count);
    }

    [Fact]
    public void RepositoryTarget_EffectivePullRequestContext_FallsBackToSingularValues()
    {
        var target = new RepositoryTarget(
            "repo",
            "AzureDevOps",
            "afs-dev",
            "risk",
            "repo",
            "https://dev.azure.com/afs-dev/risk/_git/repo",
            "main",
            "feature/rm-1",
            "main",
            42,
            "https://dev.azure.com/afs-dev/risk/_git/repo/pullrequest/42",
            null,
            null,
            "jira");

        Assert.True(target.HasPullRequestContext);
        Assert.Equal(42, target.PrimaryPullRequestId);
        Assert.Equal("https://dev.azure.com/afs-dev/risk/_git/repo/pullrequest/42", target.PrimaryPullRequestReference);
        Assert.Single(target.EffectivePullRequestIds);
        Assert.Single(target.EffectivePullRequestReferences);
    }

    private static TestGenerationRun CreateRun()
        => TestGenerationRun.Create(
            "RUN-1",
            new RawRunRequest(
                "jira-automation",
                "manual",
                new RawIssuePayload("RM-1", "1"),
                new RawTriggerInputs(
                    GenerationMode.TestCasesOnly.ToString(),
                    WorkflowPass.ScenarioDesign.ToString(),
                    null,
                    CoverageIntent.Regression.ToString(),
                    OutputTarget.JiraComment.ToString()),
                new RawRequester(null, "Tester", null)),
            "corr-1",
            DateTimeOffset.Parse("2026-03-31T10:00:00Z"));
}
