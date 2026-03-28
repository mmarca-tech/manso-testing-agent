using Manso.Domain;
using Manso.Infrastructure;

namespace Manso.UnitTests;

public sealed class RunStoreJsonSerializerTests
{
    [Fact]
    public void SerializeAndDeserialize_RoundTripsAgentRunPayloads()
    {
        var serializer = new RunStoreJsonSerializer();
        var run = TestGenerationRun.Create(
                "RUN-20260327-0001",
                new RawRunRequest(
                    "JiraAutomation",
                    "Manual",
                    new RawIssuePayload(
                        "QA-1234",
                        "10001",
                        "QA",
                        "Story",
                        "Add retry handling",
                        "Issue description",
                        "https://yourcompany.atlassian.net/browse/QA-1234"),
                    new RawTriggerInputs(
                        "ExecutableTests",
                        "ScenarioDesign",
                        "Api",
                        "payments-api",
                        "https://git.example.com/org/payments-api/pull/882",
                        "https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+Flow",
                        "Regression",
                        "Both"),
                    new RawIssueFields(
                        "payments-api",
                        "https://yourcompany.atlassian.net/wiki/spaces/API/pages/67890/Callback+Contract"),
                    new RawRequester(
                        "abc-123",
                        "Manuel Marcatili",
                        "manuel@example.com")),
                "corr-123",
                DateTimeOffset.Parse("2026-03-27T10:15:52Z"))
            .WithNormalizedRequest(new NormalizedRunRequest(
                "QA-1234",
                "https://yourcompany.atlassian.net/browse/QA-1234",
                GenerationMode.ExecutableTests,
                WorkflowPass.ScenarioDesign,
                TestScope.Api,
                "payments-api",
                "feature/QA-1234",
                ["https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+Flow"],
                CoverageIntent.Regression,
                OutputTarget.Both,
                new RequestedBy("abc-123", "Manuel Marcatili", "manuel@example.com"),
                DocumentationMode.ExplicitOnly))
            .WithStage(new RunStageRecord(
                RunStageName.RequestAccepted,
                RunStageStatus.Succeeded,
                DateTimeOffset.Parse("2026-03-27T10:15:52Z"),
                DateTimeOffset.Parse("2026-03-27T10:15:52Z"),
                "Accepted."))
            .AddStoredArtifact(new StoredArtifact(
                "ScenarioJson",
                "generated-scenarios.json",
                "application/json",
                "run://RUN-20260327-0001/generated-scenarios.json",
                """{"scenarios":[]}"""))
            .AddWarning(new RunWarning("documentation_link_ignored", "Ignored one link."))
            .AddError(new RunError("request_validation_failed", "Unsupported value.", RunStageName.RequestNormalized));

        var json = serializer.Serialize(run);
        var restored = serializer.Deserialize<TestGenerationRun>(json);

        Assert.Equal(run.RunId, restored.RunId);
        Assert.Equal(run.IssueKey, restored.IssueKey);
        Assert.Equal(run.Status, restored.Status);
        Assert.Equal(run.RawRequest.Issue.Key, restored.RawRequest.Issue.Key);
        Assert.Equal(run.NormalizedRequest?.RepositoryAlias, restored.NormalizedRequest?.RepositoryAlias);
        Assert.Single(restored.Stages);
        Assert.Single(restored.Warnings);
        Assert.Single(restored.Errors);
        Assert.Single(restored.StoredArtifacts);
    }
}
