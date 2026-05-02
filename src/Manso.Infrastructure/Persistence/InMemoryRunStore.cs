using Manso.Application;
using Manso.Domain;

namespace Manso.Infrastructure;

public sealed class InMemoryRunStore : IRunStore
{
    private readonly Dictionary<string, TestGenerationRun> _runs = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _sync = new();

    public Task CreateAsync(TestGenerationRun run, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        lock (_sync)
        {
            if (_runs.ContainsKey(run.RunId))
            {
                throw new RunAlreadyExistsException(run.RunId);
            }

            _runs.Add(run.RunId, run);
        }

        return Task.CompletedTask;
    }

    public Task<TestGenerationRun?> GetAsync(string runId, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        lock (_sync)
        {
            _runs.TryGetValue(runId, out var run);
            return Task.FromResult(run);
        }
    }

    public Task<TestGenerationRun?> FindActiveAsync(
        string issueKey,
        WorkflowPass workflowPass,
        string? repositoryAlias,
        CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        lock (_sync)
        {
            var run = _runs.Values
                .Where(run => MatchesActiveRun(run, issueKey, workflowPass, repositoryAlias))
                .OrderBy(run => run.CreatedAtUtc)
                .FirstOrDefault();
            return Task.FromResult(run);
        }
    }

    public Task UpdateAsync(string runId, Func<TestGenerationRun, TestGenerationRun> update, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        lock (_sync)
        {
            if (!_runs.TryGetValue(runId, out var existing))
            {
                throw new KeyNotFoundException($"Run '{runId}' was not found.");
            }

            _runs[runId] = update(existing);
        }

        return Task.CompletedTask;
    }

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
}
