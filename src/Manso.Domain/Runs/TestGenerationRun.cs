namespace Manso.Domain;

public sealed record TestGenerationRun(
    string RunId,
    string IssueKey,
    RunStatus Status,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset? StartedAtUtc,
    DateTimeOffset? CompletedAtUtc,
    string CorrelationId,
    RawRunRequest RawRequest,
    NormalizedRunRequest? NormalizedRequest,
    string? RepositoryAlias,
    string? PullRequestReference,
    IReadOnlyList<string> PullRequestReferences,
    IReadOnlyList<RunStageRecord> Stages,
    IReadOnlyList<RunWarning> Warnings,
    IReadOnlyList<RunError> Errors,
    IReadOnlyList<ArtifactReference> Artifacts,
    IReadOnlyList<StoredArtifact> StoredArtifacts)
{
    public static TestGenerationRun Create(
        string runId,
        RawRunRequest rawRequest,
        string correlationId,
        DateTimeOffset createdAtUtc)
    {
        EnsureRequired(runId, nameof(runId));
        ArgumentNullException.ThrowIfNull(rawRequest);
        var issueKey = rawRequest.IssueKey ?? string.Empty;
        EnsureRequired(issueKey, $"{nameof(rawRequest)}.{nameof(rawRequest.IssueKey)}");
        EnsureRequired(correlationId, nameof(correlationId));

        return new TestGenerationRun(
            runId,
            issueKey,
            RunStatus.Queued,
            createdAtUtc,
            null,
            null,
            correlationId,
            rawRequest,
            null,
            null,
            null,
            Array.Empty<string>(),
            Array.Empty<RunStageRecord>(),
            Array.Empty<RunWarning>(),
            Array.Empty<RunError>(),
            Array.Empty<ArtifactReference>(),
            Array.Empty<StoredArtifact>());
    }

    public TestGenerationRun MarkRunning(DateTimeOffset startedAtUtc)
    {
        if (IsTerminalStatus(Status))
        {
            throw new InvalidOperationException($"Run '{RunId}' is already in terminal status '{Status}' and cannot transition to Running.");
        }

        EnsureTimestampNotEarlierThan(startedAtUtc, CreatedAtUtc, nameof(startedAtUtc));
        return this with
        {
            Status = RunStatus.Running,
            StartedAtUtc = StartedAtUtc ?? startedAtUtc,
        };
    }

    public TestGenerationRun MarkCompleted(RunStatus status, DateTimeOffset completedAtUtc)
    {
        if (!IsTerminalStatus(status))
        {
            throw new InvalidOperationException($"Run completion requires a terminal status. Received '{status}'.");
        }

        EnsureTimestampNotEarlierThan(completedAtUtc, CreatedAtUtc, nameof(completedAtUtc));
        if (StartedAtUtc is not null)
        {
            EnsureTimestampNotEarlierThan(completedAtUtc, StartedAtUtc.Value, nameof(completedAtUtc));
        }

        return this with
        {
            Status = status,
            CompletedAtUtc = completedAtUtc,
        };
    }

    public TestGenerationRun WithNormalizedRequest(NormalizedRunRequest normalizedRequest)
    {
        ArgumentNullException.ThrowIfNull(normalizedRequest);
        if (!IssueKey.Equals(normalizedRequest.IssueKey, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"Normalized request issue key '{normalizedRequest.IssueKey}' does not match run issue key '{IssueKey}'.");
        }

        return this with
        {
            NormalizedRequest = normalizedRequest,
            RepositoryAlias = normalizedRequest.RepositoryAlias,
        };
    }

    public TestGenerationRun WithRepositoryTarget(RepositoryTarget target)
    {
        ArgumentNullException.ThrowIfNull(target);
        EnsureRequired(target.Alias, $"{nameof(target)}.{nameof(target.Alias)}");

        return this with
        {
            RepositoryAlias = target.Alias,
            PullRequestReference = target.PrimaryPullRequestReference,
            PullRequestReferences = target.EffectivePullRequestReferences,
        };
    }

    public TestGenerationRun WithStage(RunStageRecord stage)
    {
        return this with
        {
            Stages = UpsertBy(
                Stages,
                stage,
                static existing => existing.Name,
                static candidate => candidate.Name),
        };
    }

    public TestGenerationRun AddWarning(RunWarning warning)
    {
        EnsureRequired(warning.Code, $"{nameof(warning)}.{nameof(warning.Code)}");
        EnsureRequired(warning.Message, $"{nameof(warning)}.{nameof(warning.Message)}");
        return this with { Warnings = AppendIfMissing(Warnings, warning) };
    }

    public TestGenerationRun AddWarnings(IEnumerable<RunWarning> warnings)
    {
        ArgumentNullException.ThrowIfNull(warnings);
        var updated = this;
        foreach (var warning in warnings)
        {
            updated = updated.AddWarning(warning);
        }

        return updated;
    }

    public TestGenerationRun AddError(RunError error)
    {
        EnsureRequired(error.Code, $"{nameof(error)}.{nameof(error.Code)}");
        EnsureRequired(error.Message, $"{nameof(error)}.{nameof(error.Message)}");
        return this with { Errors = AppendIfMissing(Errors, error) };
    }

    public TestGenerationRun AddErrors(IEnumerable<RunError> errors)
    {
        ArgumentNullException.ThrowIfNull(errors);
        var updated = this;
        foreach (var error in errors)
        {
            updated = updated.AddError(error);
        }

        return updated;
    }

    public TestGenerationRun AddArtifact(ArtifactReference artifact)
    {
        EnsureRequired(artifact.Type, $"{nameof(artifact)}.{nameof(artifact.Type)}");
        EnsureRequired(artifact.Name, $"{nameof(artifact)}.{nameof(artifact.Name)}");
        EnsureRequired(artifact.ContentType, $"{nameof(artifact)}.{nameof(artifact.ContentType)}");
        EnsureRequired(artifact.Location, $"{nameof(artifact)}.{nameof(artifact.Location)}");
        return this with
        {
            Artifacts = UpsertBy(
                Artifacts,
                artifact,
                static existing => existing.Name,
                static candidate => candidate.Name),
        };
    }

    public TestGenerationRun AddStoredArtifact(StoredArtifact artifact)
    {
        EnsureRequired(artifact.Type, $"{nameof(artifact)}.{nameof(artifact.Type)}");
        EnsureRequired(artifact.Name, $"{nameof(artifact)}.{nameof(artifact.Name)}");
        EnsureRequired(artifact.ContentType, $"{nameof(artifact)}.{nameof(artifact.ContentType)}");
        EnsureRequired(artifact.Location, $"{nameof(artifact)}.{nameof(artifact.Location)}");

        var artifactReference = new ArtifactReference(
            artifact.Type,
            artifact.Name,
            artifact.ContentType,
            artifact.Content.Length,
            artifact.Location);

        return this with
        {
            Artifacts = UpsertBy(
                Artifacts,
                artifactReference,
                static existing => existing.Name,
                static candidate => candidate.Name),
            StoredArtifacts = UpsertBy(
                StoredArtifacts,
                artifact,
                static existing => existing.Name,
                static candidate => candidate.Name),
        };
    }

    public TestGenerationRun AddStoredArtifacts(IEnumerable<StoredArtifact> artifacts)
    {
        var updated = this;
        foreach (var artifact in artifacts)
        {
            updated = updated.AddStoredArtifact(artifact);
        }

        return updated;
    }

    public StoredArtifact? FindStoredArtifact(string name)
        => StoredArtifacts.FirstOrDefault(artifact => artifact.Name.Equals(name, StringComparison.OrdinalIgnoreCase));

    private static bool IsTerminalStatus(RunStatus status)
        => status is RunStatus.Succeeded or RunStatus.PartialSuccess or RunStatus.Failed or RunStatus.Cancelled;

    private static void EnsureRequired(string value, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException("A non-empty value is required.", parameterName);
        }
    }

    private static void EnsureTimestampNotEarlierThan(
        DateTimeOffset value,
        DateTimeOffset minimum,
        string parameterName)
    {
        if (value < minimum)
        {
            throw new InvalidOperationException(
                $"Timestamp '{parameterName}' cannot be earlier than '{minimum:O}'.");
        }
    }

    private static IReadOnlyList<T> AppendIfMissing<T>(
        IReadOnlyList<T> existingItems,
        T candidate)
        where T : notnull
    {
        if (existingItems.Contains(candidate))
        {
            return existingItems;
        }

        var merged = existingItems.ToList();
        merged.Add(candidate);
        return merged;
    }

    private static IReadOnlyList<T> UpsertBy<T, TKey>(
        IReadOnlyList<T> existingItems,
        T candidate,
        Func<T, TKey> existingKeySelector,
        Func<T, TKey> candidateKeySelector)
        where TKey : notnull
    {
        var merged = existingItems.ToList();
        var candidateKey = candidateKeySelector(candidate);
        var existingIndex = merged.FindIndex(existing =>
            EqualityComparer<TKey>.Default.Equals(existingKeySelector(existing), candidateKey));
        if (existingIndex >= 0)
        {
            merged[existingIndex] = candidate;
        }
        else
        {
            merged.Add(candidate);
        }

        return merged;
    }
}

public sealed record RunStageRecord(
    RunStageName Name,
    RunStageStatus Status,
    DateTimeOffset StartedAtUtc,
    DateTimeOffset? CompletedAtUtc,
    string? Details)
{
    public long? DurationMs
        => CompletedAtUtc is null
            ? null
            : Math.Max(0, (long)(CompletedAtUtc.Value - StartedAtUtc).TotalMilliseconds);

    public IReadOnlyDictionary<string, string> Metrics { get; init; } =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
}

public sealed record RunWarning(
    string Code,
    string Message);

public sealed record RunError(
    string Code,
    string Message,
    RunStageName? Stage);

public sealed record ArtifactReference(
    string Type,
    string Name,
    string ContentType,
    long SizeBytes,
    string Location);

public sealed record StoredArtifact(
    string Type,
    string Name,
    string ContentType,
    string Location,
    string Content);
