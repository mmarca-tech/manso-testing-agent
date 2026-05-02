using Manso.Application;
using Manso.Domain;
using Manso.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;
using System.Threading.Channels;

namespace Manso.UnitTests;

public sealed class RunExecutionBackgroundServiceTests
{
    [Fact]
    public async Task ExecuteAsync_MarksRunFailed_WhenUnexpectedExceptionEscapesRunExecution()
    {
        var queue = new StubBackgroundRunQueue();
        var runStore = new InMemoryRunStore();
        var createdAt = new DateTimeOffset(2026, 03, 31, 10, 00, 00, TimeSpan.Zero);
        await runStore.CreateAsync(
            TestGenerationRun.Create(
                "RUN-1",
                new RawRunRequest(
                    WorkflowPass.ScenarioDesign.ToString(),
                    "RM-1",
                    "tester"),
                "corr-1",
                createdAt),
            CancellationToken.None);

        await queue.QueueAsync("RUN-1", CancellationToken.None);

        var service = new RunExecutionBackgroundService(
            queue,
            new ThrowingRunService(),
            runStore,
            new FakeTimeProvider(new DateTimeOffset(2026, 03, 31, 10, 05, 00, TimeSpan.Zero)),
            NullLogger<RunExecutionBackgroundService>.Instance);

        using var cts = new CancellationTokenSource();
        await service.StartAsync(cts.Token);
        await WaitUntilAsync(
            async () =>
            {
                var run = await runStore.GetAsync("RUN-1", CancellationToken.None);
                return run?.Status == RunStatus.Failed;
            },
            TimeSpan.FromSeconds(5));
        cts.Cancel();
        await service.StopAsync(CancellationToken.None);

        var updatedRun = await runStore.GetAsync("RUN-1", CancellationToken.None);
        Assert.NotNull(updatedRun);
        Assert.Equal(RunStatus.Failed, updatedRun.Status);
        Assert.NotNull(updatedRun.StartedAtUtc);
        Assert.NotNull(updatedRun.CompletedAtUtc);
        var error = Assert.Single(updatedRun.Errors);
        Assert.Equal("background_execution_failed", error.Code);
        Assert.Contains("boom", error.Message, StringComparison.Ordinal);
    }

    private static async Task WaitUntilAsync(Func<Task<bool>> condition, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow.Add(timeout);
        while (DateTime.UtcNow < deadline)
        {
            if (await condition())
            {
                return;
            }

            await Task.Delay(50);
        }

        throw new TimeoutException("Condition was not met within the timeout.");
    }

    private sealed class ThrowingRunService : ITestGenerationRunService
    {
        public Task<RunAcceptedResponse> StartAsync(RawRunRequest request, string correlationId, CancellationToken ct)
            => throw new NotSupportedException();

        public Task ExecuteAsync(string runId, CancellationToken ct)
            => throw new InvalidOperationException("boom");

        public Task<TestGenerationRun?> GetAsync(string runId, CancellationToken ct)
            => throw new NotSupportedException();
    }

    private sealed class StubBackgroundRunQueue : IBackgroundRunQueue
    {
        private readonly Channel<string> _channel = Channel.CreateUnbounded<string>();

        public ValueTask QueueAsync(string runId, CancellationToken ct)
            => _channel.Writer.WriteAsync(runId, ct);

        public ValueTask<string> DequeueAsync(CancellationToken ct)
            => _channel.Reader.ReadAsync(ct);
    }

    private sealed class FakeTimeProvider : TimeProvider
    {
        private readonly DateTimeOffset _utcNow;

        public FakeTimeProvider(DateTimeOffset utcNow)
        {
            _utcNow = utcNow;
        }

        public override DateTimeOffset GetUtcNow() => _utcNow;
    }
}
