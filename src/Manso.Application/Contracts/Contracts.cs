using Manso.Domain;

namespace Manso.Application;

public interface ITestGenerationRunService
{
    Task<RunAcceptedResponse> StartAsync(RawRunRequest request, string correlationId, CancellationToken ct);

    Task ExecuteAsync(string runId, CancellationToken ct);

    Task<TestGenerationRun?> GetAsync(string runId, CancellationToken ct);
}

public interface IRequestNormalizer
{
    Task<NormalizedRunRequest> NormalizeAsync(RawRunRequest request, CancellationToken ct);
}

public interface IRunStore
{
    Task CreateAsync(TestGenerationRun run, CancellationToken ct);

    Task<TestGenerationRun?> GetAsync(string runId, CancellationToken ct);

    Task<TestGenerationRun?> FindActiveAsync(
        string issueKey,
        WorkflowPass workflowPass,
        string? repositoryAlias,
        CancellationToken ct);

    Task UpdateAsync(string runId, Func<TestGenerationRun, TestGenerationRun> update, CancellationToken ct);
}

public interface IBackgroundRunQueue
{
    ValueTask QueueAsync(string runId, CancellationToken ct);

    ValueTask<string> DequeueAsync(CancellationToken ct);
}

public interface IRunIdFactory
{
    string Create();
}

public sealed class RunAlreadyExistsException : Exception
{
    public RunAlreadyExistsException(string runId, Exception? innerException = null)
        : base($"Run '{runId}' already exists.", innerException)
    {
        RunId = runId;
    }

    public string RunId { get; }
}

public sealed record RunAcceptedResponse(
    string RunId,
    RunStatus Status,
    DateTimeOffset AcceptedAtUtc,
    string CorrelationId);

public sealed class RequestNormalizationOptions
{
    public const string SectionName = "RequestNormalization";

    public TestScope DefaultTestScope { get; init; } = TestScope.Api;
}
