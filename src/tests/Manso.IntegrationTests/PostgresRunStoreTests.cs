using Manso.Domain;
using Manso.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;

namespace Manso.IntegrationTests;

public sealed class PostgresRunStoreTests
{
    [Fact]
    public async Task PostgresRunStore_RoundtripsNormalizedRequestStagesErrorsWarningsAndArtifacts()
    {
        var connectionString = Environment.GetEnvironmentVariable("MANSO_POSTGRES_RUNSTORE_TEST_CONNECTION");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            return;
        }

        await using var dataSource = new NpgsqlDataSourceBuilder(connectionString).Build();
        await new RunStoreSchemaInitializer(
                new RunPersistenceOptions
                {
                    Provider = RunPersistenceProvider.Postgres,
                    AutoInitializeSchema = true,
                },
                NullLogger<RunStoreSchemaInitializer>.Instance,
                dataSource)
            .InitializeAsync(CancellationToken.None);

        var store = new PostgresRunStore(
            dataSource,
            new RunStoreJsonSerializer(),
            NullLogger<PostgresRunStore>.Instance);
        var runId = $"it-{Guid.NewGuid():N}";
        var createdAtUtc = DateTimeOffset.UtcNow;
        var run = TestGenerationRun.Create(
                runId,
                CreateRequest(),
                "corr-postgres",
                createdAtUtc)
            .WithNormalizedRequest(CreateNormalizedRequest())
            .WithStage(new RunStageRecord(
                RunStageName.RequestAccepted,
                RunStageStatus.Succeeded,
                createdAtUtc,
                createdAtUtc,
                "Accepted."))
            .AddWarning(new RunWarning("docs_missing", "No explicit docs were supplied."))
            .AddError(new RunError("validation_warning", "A deterministic validation warning was recorded.", RunStageName.OutputsValidated))
            .AddStoredArtifact(new StoredArtifact(
                "GenerationContextBundleJson",
                "generation-context-bundle.json",
                "application/json",
                $"run://{runId}/generation-context-bundle.json",
                "{}"));

        await store.CreateAsync(run, CancellationToken.None);

        var active = await store.FindActiveAsync(
            "QA-PG",
            WorkflowPass.ScenarioDesign,
            "SomeRepo",
            CancellationToken.None);
        Assert.NotNull(active);
        Assert.Equal(runId, active.RunId);

        var completedAtUtc = createdAtUtc.AddSeconds(2);
        await store.UpdateAsync(
            runId,
            current => current
                .MarkRunning(createdAtUtc.AddSeconds(1))
                .WithStage(new RunStageRecord(
                    RunStageName.OutputsWritten,
                    RunStageStatus.Succeeded,
                    createdAtUtc.AddSeconds(1),
                    completedAtUtc,
                    "Artifacts written."))
                .AddStoredArtifact(new StoredArtifact(
                    "WriteResultJson",
                    "write-result.json",
                    "application/json",
                    $"run://{runId}/write-result.json",
                    """{"status":"ScenarioArtifactsStored"}"""))
                .MarkCompleted(RunStatus.PartialSuccess, completedAtUtc),
            CancellationToken.None);

        var fetched = await store.GetAsync(runId, CancellationToken.None);

        Assert.NotNull(fetched);
        Assert.Equal(RunStatus.PartialSuccess, fetched.Status);
        Assert.Equal("QA-PG", fetched.IssueKey);
        Assert.Equal("SomeRepo", fetched.RepositoryAlias);
        Assert.Contains(fetched.Stages, stage => stage.Name == RunStageName.RequestAccepted);
        Assert.Contains(fetched.Stages, stage => stage.Name == RunStageName.OutputsWritten);
        Assert.Contains(fetched.Warnings, warning => warning.Code == "docs_missing");
        Assert.Contains(fetched.Errors, error => error.Code == "validation_warning");
        Assert.Contains(fetched.StoredArtifacts, artifact => artifact.Name == "generation-context-bundle.json");
        Assert.Contains(fetched.StoredArtifacts, artifact => artifact.Name == "write-result.json");

        var completedActive = await store.FindActiveAsync(
            "QA-PG",
            WorkflowPass.ScenarioDesign,
            "SomeRepo",
            CancellationToken.None);
        Assert.Null(completedActive);
    }

    private static RawRunRequest CreateRequest()
        => new(
            "ScenarioDesign",
            "QA-PG",
            "abc-123");

    private static NormalizedRunRequest CreateNormalizedRequest()
        => new(
            "QA-PG",
            WorkflowPass.ScenarioDesign,
            TestScope.Api,
            "SomeRepo",
            "abc-123");
}
