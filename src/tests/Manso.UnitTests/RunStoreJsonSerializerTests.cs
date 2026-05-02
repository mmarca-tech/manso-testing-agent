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
                    "ScenarioDesign",
                    "QA-1234",
                    "abc-123"),
                "corr-123",
                DateTimeOffset.Parse("2026-03-27T10:15:52Z"))
            .WithNormalizedRequest(new NormalizedRunRequest(
                "QA-1234",
                WorkflowPass.ScenarioDesign,
                TestScope.Api,
                "payments-api",
                "abc-123"))
            .WithStage(new RunStageRecord(
                RunStageName.RequestAccepted,
                RunStageStatus.Succeeded,
                DateTimeOffset.Parse("2026-03-27T10:15:52Z"),
                DateTimeOffset.Parse("2026-03-27T10:15:52Z"),
                "Accepted.")
            {
                Metrics = new Dictionary<string, string>
                {
                    ["providerRequestCount"] = "1",
                    ["warningCount"] = "0",
                },
            })
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
        Assert.Equal(run.RawRequest.IssueKey, restored.RawRequest.IssueKey);
        Assert.Equal(run.NormalizedRequest?.RepositoryAlias, restored.NormalizedRequest?.RepositoryAlias);
        var restoredStage = Assert.Single(restored.Stages);
        Assert.Equal(0, restoredStage.DurationMs);
        Assert.Equal("1", restoredStage.Metrics["providerRequestCount"]);
        Assert.Single(restored.Warnings);
        Assert.Single(restored.Errors);
        Assert.Single(restored.StoredArtifacts);
    }
}
