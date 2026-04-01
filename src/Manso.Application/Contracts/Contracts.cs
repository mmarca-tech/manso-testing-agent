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
    Task<NormalizationResult> NormalizeAsync(RawRunRequest request, CancellationToken ct);
}

public interface IRunStore
{
    Task CreateAsync(TestGenerationRun run, CancellationToken ct);

    Task<TestGenerationRun?> GetAsync(string runId, CancellationToken ct);

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

public sealed record RunAcceptedResponse(
    string RunId,
    RunStatus Status,
    DateTimeOffset AcceptedAtUtc,
    string CorrelationId);

public sealed record NormalizationResult(
    NormalizedRunRequest Request,
    IReadOnlyList<RunWarning> Warnings);

public sealed class RequestNormalizationOptions
{
    public const string SectionName = "RequestNormalization";

    public string[] AllowedConfluenceHosts { get; init; } = Array.Empty<string>();

    public GenerationMode DefaultGenerationMode { get; init; } = GenerationMode.TestCasesOnly;

    public WorkflowPass DefaultWorkflowPass { get; init; } = WorkflowPass.ScenarioDesign;

    public TestScope DefaultTestScope { get; init; } = TestScope.Api;

    public CoverageIntent DefaultCoverageIntent { get; init; } = CoverageIntent.Regression;

    public OutputTarget DefaultOutputTarget { get; init; } = OutputTarget.JiraComment;
}
