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

    private TestGenerationRun MapRun(NpgsqlDataReader reader)
    {
        var rawRequest = _serializer.Deserialize<RawRunRequest>(reader.GetString(7));
        var normalizedRequest = reader.IsDBNull(8)
            ? null
            : _serializer.Deserialize<NormalizedRunRequest>(reader.GetString(8));
        var pullRequestReferences = reader.IsDBNull(11)
            ? Array.Empty<string>()
            : _serializer.Deserialize<IReadOnlyList<string>>(reader.GetString(11));
        var stages = _serializer.Deserialize<IReadOnlyList<RunStageRecord>>(reader.GetString(12));
        var warnings = _serializer.Deserialize<IReadOnlyList<RunWarning>>(reader.GetString(13));
        var errors = _serializer.Deserialize<IReadOnlyList<RunError>>(reader.GetString(14));
        var artifacts = _serializer.Deserialize<IReadOnlyList<ArtifactReference>>(reader.GetString(15));
        var storedArtifacts = reader.IsDBNull(16)
            ? Array.Empty<StoredArtifact>()
            : _serializer.Deserialize<IReadOnlyList<StoredArtifact>>(reader.GetString(16));

        return new TestGenerationRun(
            reader.GetString(0),
            reader.GetString(1),
            Enum.Parse<RunStatus>(reader.GetString(2), ignoreCase: true),
            new DateTimeOffset(DateTime.SpecifyKind(reader.GetDateTime(3), DateTimeKind.Utc)),
            reader.IsDBNull(4)
                ? null
                : new DateTimeOffset(DateTime.SpecifyKind(reader.GetDateTime(4), DateTimeKind.Utc)),
            reader.IsDBNull(5)
                ? null
                : new DateTimeOffset(DateTime.SpecifyKind(reader.GetDateTime(5), DateTimeKind.Utc)),
            reader.GetString(6),
            rawRequest,
            normalizedRequest,
            reader.IsDBNull(9) ? null : reader.GetString(9),
            reader.IsDBNull(10) ? null : reader.GetString(10),
            pullRequestReferences,
            stages,
            warnings,
            errors,
            artifacts,
            storedArtifacts);
    }
}
