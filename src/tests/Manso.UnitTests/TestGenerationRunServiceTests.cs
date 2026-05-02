using Manso.Application;
using Manso.Domain;
using Manso.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;

namespace Manso.UnitTests;

public sealed class TestGenerationRunServiceTests
{
    [Fact]
    public async Task StartAsync_RejectsDuplicateActiveRunForSameIssueModeAndRepository()
    {
        var store = new InMemoryRunStore();
        var queue = new CapturingBackgroundRunQueue();
        var service = CreateService(store, queue);
        var request = CreateRequest();

        var accepted = await service.StartAsync(request, "corr-1", CancellationToken.None);

        var persisted = await store.GetAsync(accepted.RunId, CancellationToken.None);
        Assert.NotNull(persisted);
        Assert.Equal(RunStatus.Queued, persisted.Status);
        Assert.Null(persisted.RepositoryAlias);
        var acceptedStage = Assert.Single(persisted.Stages);
        Assert.Equal(RunStageName.RequestAccepted, acceptedStage.Name);
        Assert.Equal(0, acceptedStage.DurationMs);
        Assert.Equal("ScenarioDesign", acceptedStage.Metrics["workflowPass"]);
        Assert.Equal(["run-1"], queue.RunIds);

        var exception = await Assert.ThrowsAsync<RequestValidationException>(
            () => service.StartAsync(request, "corr-2", CancellationToken.None));

        Assert.Equal("issueKey", exception.Field);
        Assert.Equal("QA-1234", exception.Value);
        Assert.Contains(accepted.RunId, exception.Message);
        Assert.Equal(["run-1"], queue.RunIds);
    }

    private static TestGenerationRunService CreateService(
        IRunStore runStore,
        IBackgroundRunQueue queue)
        => new(
            queue,
            documentationResolver: null!,
            generationContextBundleBuilder: null!,
            jiraContextService: null!,
            repositoryContextService: null!,
            repositoryResolver: null!,
            xrayContextService: null!,
            xrayTestCaseSyncService: null!,
            new XrayRetrievalOptions(),
            outputValidator: null!,
            outputWriter: null!,
            scenarioGenerator: null!,
            new SequentialRunIdFactory(),
            new RequestNormalizer(new RequestNormalizationOptions()),
            runStore,
            TimeProvider.System,
            NullLogger<TestGenerationRunService>.Instance);

    private static RawRunRequest CreateRequest()
        => new(
            "ScenarioDesign",
            "QA-1234",
            "abc-123");

    private sealed class CapturingBackgroundRunQueue : IBackgroundRunQueue
    {
        private readonly List<string> _runIds = [];

        public IReadOnlyList<string> RunIds => _runIds;

        public ValueTask QueueAsync(string runId, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            _runIds.Add(runId);
            return ValueTask.CompletedTask;
        }

        public ValueTask<string> DequeueAsync(CancellationToken ct)
            => throw new NotSupportedException();
    }

    private sealed class SequentialRunIdFactory : IRunIdFactory
    {
        private int _next;

        public string Create()
            => $"run-{Interlocked.Increment(ref _next)}";
    }
}
