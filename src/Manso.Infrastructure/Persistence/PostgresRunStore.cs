using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging;
using Npgsql;
using NpgsqlTypes;

namespace Manso.Infrastructure;

public sealed class PostgresRunStore : IRunStore
{
    private const string SelectColumns = """
        SELECT
            run_id,
            issue_key,
            status,
            created_at_utc,
            started_at_utc,
            completed_at_utc,
            correlation_id,
            raw_request,
            normalized_request,
            repository_alias,
            pull_request_reference,
            pull_request_references,
            stages,
            warnings,
            errors,
            artifacts,
            stored_artifacts
        FROM agent_runs
        """;

    private readonly NpgsqlDataSource _dataSource;
    private readonly RunStoreJsonSerializer _serializer;
    private readonly ILogger<PostgresRunStore> _logger;

    public PostgresRunStore(
        NpgsqlDataSource dataSource,
        RunStoreJsonSerializer serializer,
        ILogger<PostgresRunStore> logger)
    {
        _dataSource = dataSource;
        _serializer = serializer;
        _logger = logger;
    }

    public async Task CreateAsync(TestGenerationRun run, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        try
        {
            await using var command = _dataSource.CreateCommand(
                """
                INSERT INTO agent_runs (
                    run_id,
                    issue_key,
                    status,
                    created_at_utc,
                    started_at_utc,
                    completed_at_utc,
                    correlation_id,
                    raw_request,
                    normalized_request,
                    repository_alias,
                    pull_request_reference,
                    pull_request_references,
                    stages,
                    warnings,
                    errors,
                    artifacts,
                    stored_artifacts)
                VALUES (
                    @run_id,
                    @issue_key,
                    @status,
                    @created_at_utc,
                    @started_at_utc,
                    @completed_at_utc,
                    @correlation_id,
                    @raw_request,
                    @normalized_request,
                    @repository_alias,
                    @pull_request_reference,
                    @pull_request_references,
                    @stages,
                    @warnings,
                    @errors,
                    @artifacts,
                    @stored_artifacts);
                """);

            BindRun(command, run);
            await command.ExecuteNonQueryAsync(ct);
        }
        catch (PostgresException ex) when (IsDuplicateRunId(ex))
        {
            throw new RunAlreadyExistsException(run.RunId, ex);
        }

        _logger.LogInformation(
            "Persisted run {RunId} to Postgres for issue {IssueKey}.",
            run.RunId,
            run.IssueKey);
    }

    public async Task<TestGenerationRun?> GetAsync(string runId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        await using var command = _dataSource.CreateCommand(
            $"{SelectColumns} WHERE run_id = @run_id;");
        command.Parameters.AddWithValue("run_id", runId);

        await using var reader = await command.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct))
        {
            return null;
        }

        return MapRun(reader);
    }

    public async Task<TestGenerationRun?> FindActiveAsync(
        string issueKey,
        WorkflowPass workflowPass,
        string? repositoryAlias,
        CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        await using var command = _dataSource.CreateCommand(
            $"{SelectColumns} WHERE issue_key = @issue_key AND status IN ('Queued', 'Running') ORDER BY created_at_utc ASC;");
        command.Parameters.AddWithValue("issue_key", issueKey);

        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            var run = MapRun(reader);
            if (MatchesActiveRun(run, issueKey, workflowPass, repositoryAlias))
            {
                return run;
            }
        }

        return null;
    }

    public async Task UpdateAsync(string runId, Func<TestGenerationRun, TestGenerationRun> update, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        await using var connection = await _dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        TestGenerationRun current;
        await using (var selectCommand = connection.CreateCommand())
        {
            selectCommand.Transaction = transaction;
            selectCommand.CommandText = $"{SelectColumns} WHERE run_id = @run_id FOR UPDATE;";
            selectCommand.Parameters.AddWithValue("run_id", runId);

            await using var reader = await selectCommand.ExecuteReaderAsync(ct);
            if (!await reader.ReadAsync(ct))
            {
                throw new KeyNotFoundException($"Run '{runId}' was not found.");
            }

            current = MapRun(reader);
        }

        var updated = update(current);

        await using (var updateCommand = connection.CreateCommand())
        {
            updateCommand.Transaction = transaction;
            updateCommand.CommandText =
                """
                UPDATE agent_runs
                SET
                    issue_key = @issue_key,
                    status = @status,
                    created_at_utc = @created_at_utc,
                    started_at_utc = @started_at_utc,
                    completed_at_utc = @completed_at_utc,
                    correlation_id = @correlation_id,
                    raw_request = @raw_request,
                    normalized_request = @normalized_request,
                    repository_alias = @repository_alias,
                    pull_request_reference = @pull_request_reference,
                    pull_request_references = @pull_request_references,
                    stages = @stages,
                    warnings = @warnings,
                    errors = @errors,
                    artifacts = @artifacts,
                    stored_artifacts = @stored_artifacts
                WHERE run_id = @run_id;
                """;

            BindRun(updateCommand, updated);
            await updateCommand.ExecuteNonQueryAsync(ct);
        }

        await transaction.CommitAsync(ct);
    }

    private void BindRun(NpgsqlCommand command, TestGenerationRun run)
    {
        command.Parameters.Clear();
        command.Parameters.AddWithValue("run_id", run.RunId);
        command.Parameters.AddWithValue("issue_key", run.IssueKey);
        command.Parameters.AddWithValue("status", run.Status.ToString());
        command.Parameters.AddWithValue("created_at_utc", run.CreatedAtUtc.UtcDateTime);
        command.Parameters.AddWithValue("started_at_utc", run.StartedAtUtc?.UtcDateTime ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("completed_at_utc", run.CompletedAtUtc?.UtcDateTime ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("correlation_id", run.CorrelationId);
        command.Parameters.Add(new NpgsqlParameter("raw_request", NpgsqlDbType.Jsonb)
        {
            Value = _serializer.Serialize(run.RawRequest),
        });
        command.Parameters.Add(new NpgsqlParameter("normalized_request", NpgsqlDbType.Jsonb)
        {
            Value = run.NormalizedRequest is null
                ? DBNull.Value
                : _serializer.Serialize(run.NormalizedRequest),
        });
        command.Parameters.AddWithValue("repository_alias", run.RepositoryAlias ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("pull_request_reference", run.PullRequestReference ?? (object)DBNull.Value);
        command.Parameters.Add(new NpgsqlParameter("pull_request_references", NpgsqlDbType.Jsonb)
        {
            Value = _serializer.Serialize(run.PullRequestReferences),
        });
        command.Parameters.Add(new NpgsqlParameter("stages", NpgsqlDbType.Jsonb)
        {
            Value = _serializer.Serialize(run.Stages),
        });
        command.Parameters.Add(new NpgsqlParameter("warnings", NpgsqlDbType.Jsonb)
        {
            Value = _serializer.Serialize(run.Warnings),
        });
        command.Parameters.Add(new NpgsqlParameter("errors", NpgsqlDbType.Jsonb)
        {
            Value = _serializer.Serialize(run.Errors),
        });
        command.Parameters.Add(new NpgsqlParameter("artifacts", NpgsqlDbType.Jsonb)
        {
            Value = _serializer.Serialize(run.Artifacts),
        });
        command.Parameters.Add(new NpgsqlParameter("stored_artifacts", NpgsqlDbType.Jsonb)
        {
            Value = _serializer.Serialize(run.StoredArtifacts),
        });
    }

    private static bool IsDuplicateRunId(PostgresException exception)
        => exception.SqlState == PostgresErrorCodes.UniqueViolation &&
           string.Equals(exception.ConstraintName, "agent_runs_pkey", StringComparison.OrdinalIgnoreCase);

    private TestGenerationRun MapRun(NpgsqlDataReader reader)
    {
        var columns = RunRecordColumns.From(reader);
        var rawRequest = DeserializeJson<RawRunRequest>(reader, columns.RawRequest);
        var normalizedRequest = DeserializeNullableJson<NormalizedRunRequest>(reader, columns.NormalizedRequest);
        var pullRequestReferences = DeserializeNullableJson<IReadOnlyList<string>>(
            reader,
            columns.PullRequestReferences) ?? Array.Empty<string>();
        var stages = DeserializeJson<IReadOnlyList<RunStageRecord>>(reader, columns.Stages);
        var warnings = DeserializeJson<IReadOnlyList<RunWarning>>(reader, columns.Warnings);
        var errors = DeserializeJson<IReadOnlyList<RunError>>(reader, columns.Errors);
        var artifacts = DeserializeJson<IReadOnlyList<ArtifactReference>>(reader, columns.Artifacts);
        var storedArtifacts = DeserializeNullableJson<IReadOnlyList<StoredArtifact>>(
            reader,
            columns.StoredArtifacts) ?? Array.Empty<StoredArtifact>();

        return new TestGenerationRun(
            reader.GetString(columns.RunId),
            reader.GetString(columns.IssueKey),
            Enum.Parse<RunStatus>(reader.GetString(columns.Status), ignoreCase: true),
            GetUtcDateTimeOffset(reader, columns.CreatedAtUtc),
            GetNullableUtcDateTimeOffset(reader, columns.StartedAtUtc),
            GetNullableUtcDateTimeOffset(reader, columns.CompletedAtUtc),
            reader.GetString(columns.CorrelationId),
            rawRequest,
            normalizedRequest,
            GetNullableString(reader, columns.RepositoryAlias),
            GetNullableString(reader, columns.PullRequestReference),
            pullRequestReferences,
            stages,
            warnings,
            errors,
            artifacts,
            storedArtifacts);
    }

    private T DeserializeJson<T>(NpgsqlDataReader reader, int ordinal)
        => _serializer.Deserialize<T>(reader.GetString(ordinal));

    private T? DeserializeNullableJson<T>(NpgsqlDataReader reader, int ordinal)
        => reader.IsDBNull(ordinal)
            ? default
            : _serializer.Deserialize<T>(reader.GetString(ordinal));

    private static string? GetNullableString(NpgsqlDataReader reader, int ordinal)
        => reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);

    private static DateTimeOffset GetUtcDateTimeOffset(NpgsqlDataReader reader, int ordinal)
        => new(DateTime.SpecifyKind(reader.GetDateTime(ordinal), DateTimeKind.Utc));

    private static DateTimeOffset? GetNullableUtcDateTimeOffset(NpgsqlDataReader reader, int ordinal)
        => reader.IsDBNull(ordinal) ? null : GetUtcDateTimeOffset(reader, ordinal);

    private static bool MatchesActiveRun(
        TestGenerationRun run,
        string issueKey,
        WorkflowPass workflowPass,
        string? repositoryAlias)
        => run.Status is RunStatus.Queued or RunStatus.Running &&
           run.IssueKey.Equals(issueKey, StringComparison.OrdinalIgnoreCase) &&
           run.NormalizedRequest is { } normalized &&
           normalized.WorkflowPass == workflowPass &&
           string.Equals(normalized.RepositoryAlias, repositoryAlias, StringComparison.OrdinalIgnoreCase);

    private readonly record struct RunRecordColumns(
        int RunId,
        int IssueKey,
        int Status,
        int CreatedAtUtc,
        int StartedAtUtc,
        int CompletedAtUtc,
        int CorrelationId,
        int RawRequest,
        int NormalizedRequest,
        int RepositoryAlias,
        int PullRequestReference,
        int PullRequestReferences,
        int Stages,
        int Warnings,
        int Errors,
        int Artifacts,
        int StoredArtifacts)
    {
        public static RunRecordColumns From(NpgsqlDataReader reader)
            => new(
                reader.GetOrdinal("run_id"),
                reader.GetOrdinal("issue_key"),
                reader.GetOrdinal("status"),
                reader.GetOrdinal("created_at_utc"),
                reader.GetOrdinal("started_at_utc"),
                reader.GetOrdinal("completed_at_utc"),
                reader.GetOrdinal("correlation_id"),
                reader.GetOrdinal("raw_request"),
                reader.GetOrdinal("normalized_request"),
                reader.GetOrdinal("repository_alias"),
                reader.GetOrdinal("pull_request_reference"),
                reader.GetOrdinal("pull_request_references"),
                reader.GetOrdinal("stages"),
                reader.GetOrdinal("warnings"),
                reader.GetOrdinal("errors"),
                reader.GetOrdinal("artifacts"),
                reader.GetOrdinal("stored_artifacts"));
    }
}
