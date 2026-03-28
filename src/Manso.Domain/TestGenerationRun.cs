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
        return new TestGenerationRun(
            runId,
            rawRequest.Issue.Key,
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
        => this with
        {
            Status = RunStatus.Running,
            StartedAtUtc = StartedAtUtc ?? startedAtUtc,
        };

    public TestGenerationRun MarkCompleted(RunStatus status, DateTimeOffset completedAtUtc)
        => this with
        {
            Status = status,
            CompletedAtUtc = completedAtUtc,
        };

    public TestGenerationRun WithNormalizedRequest(NormalizedRunRequest normalizedRequest)
        => this with
        {
            NormalizedRequest = normalizedRequest,
            RepositoryAlias = normalizedRequest.RepositoryAlias,
        };

    public TestGenerationRun WithRepositoryTarget(RepositoryTarget target)
        => this with
        {
            RepositoryAlias = target.Alias,
            PullRequestReference = target.PullRequestReference ?? target.PullRequestReferences.FirstOrDefault(),
            PullRequestReferences = target.PullRequestReferences.Count > 0
                ? target.PullRequestReferences
                : target.PullRequestReference is null
                    ? Array.Empty<string>()
                    : [target.PullRequestReference],
        };

    public TestGenerationRun WithStage(RunStageRecord stage)
    {
        var stages = Stages.ToList();
        var existingIndex = stages.FindIndex(x => x.Name == stage.Name);
        if (existingIndex >= 0)
        {
            stages[existingIndex] = stage;
        }
        else
        {
            stages.Add(stage);
        }

        return this with { Stages = stages };
    }

    public TestGenerationRun AddWarning(RunWarning warning)
    {
        var warnings = Warnings.ToList();
        warnings.Add(warning);
        return this with { Warnings = warnings };
    }

    public TestGenerationRun AddWarnings(IEnumerable<RunWarning> warnings)
    {
        var merged = Warnings.ToList();
        merged.AddRange(warnings);
        return this with { Warnings = merged };
    }

    public TestGenerationRun AddError(RunError error)
    {
        var errors = Errors.ToList();
        errors.Add(error);
        return this with { Errors = errors };
    }

    public TestGenerationRun AddErrors(IEnumerable<RunError> errors)
    {
        var merged = Errors.ToList();
        merged.AddRange(errors);
        return this with { Errors = merged };
    }

    public TestGenerationRun AddArtifact(ArtifactReference artifact)
    {
        var artifacts = Artifacts.ToList();
        artifacts.Add(artifact);
        return this with { Artifacts = artifacts };
    }

    public TestGenerationRun AddStoredArtifact(StoredArtifact artifact)
    {
        var artifacts = Artifacts.ToList();
        artifacts.RemoveAll(existing => existing.Name.Equals(artifact.Name, StringComparison.OrdinalIgnoreCase));
        artifacts.Add(new ArtifactReference(
            artifact.Type,
            artifact.Name,
            artifact.ContentType,
            artifact.Content.Length,
            artifact.Location));

        var stored = StoredArtifacts.ToList();
        stored.RemoveAll(existing => existing.Name.Equals(artifact.Name, StringComparison.OrdinalIgnoreCase));
        stored.Add(artifact);

        return this with
        {
            Artifacts = artifacts,
            StoredArtifacts = stored,
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
}

public sealed record RunStageRecord(
    RunStageName Name,
    RunStageStatus Status,
    DateTimeOffset StartedAtUtc,
    DateTimeOffset? CompletedAtUtc,
    string? Details);

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
