using Microsoft.Extensions.Logging;
using Npgsql;

namespace Manso.Infrastructure;

public sealed class RunStoreSchemaInitializer
{
    private readonly RunPersistenceOptions _options;
    private readonly NpgsqlDataSource? _dataSource;
    private readonly ILogger<RunStoreSchemaInitializer> _logger;

    public RunStoreSchemaInitializer(
        RunPersistenceOptions options,
        ILogger<RunStoreSchemaInitializer> logger,
        NpgsqlDataSource? dataSource = null)
    {
        _options = options;
        _logger = logger;
        _dataSource = dataSource;
    }

    public async Task InitializeAsync(CancellationToken ct)
    {
        if (_options.Provider != RunPersistenceProvider.Postgres || !_options.AutoInitializeSchema)
        {
            return;
        }

        if (_dataSource is null)
        {
            throw new InvalidOperationException("Postgres schema initialization was requested but no data source is registered.");
        }

        await using var command = _dataSource.CreateCommand(
            """
            CREATE TABLE IF NOT EXISTS agent_runs (
                run_id text PRIMARY KEY,
                issue_key text NOT NULL,
                status text NOT NULL,
                created_at_utc timestamptz NOT NULL,
                started_at_utc timestamptz NULL,
                completed_at_utc timestamptz NULL,
                correlation_id text NOT NULL,
                raw_request jsonb NOT NULL,
                normalized_request jsonb NULL,
                repository_alias text NULL,
                pull_request_reference text NULL,
                pull_request_references jsonb NOT NULL DEFAULT '[]'::jsonb,
                stages jsonb NOT NULL,
                warnings jsonb NOT NULL,
                errors jsonb NOT NULL,
                artifacts jsonb NOT NULL,
                stored_artifacts jsonb NOT NULL DEFAULT '[]'::jsonb
            );

            ALTER TABLE agent_runs
                ADD COLUMN IF NOT EXISTS pull_request_references jsonb NOT NULL DEFAULT '[]'::jsonb;

            ALTER TABLE agent_runs
                ADD COLUMN IF NOT EXISTS stored_artifacts jsonb NOT NULL DEFAULT '[]'::jsonb;

            CREATE INDEX IF NOT EXISTS ix_agent_runs_issue_key
                ON agent_runs (issue_key);
            """);

        await command.ExecuteNonQueryAsync(ct);

        _logger.LogInformation("Run store schema initialization completed for Postgres.");
    }
}
