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
                throw new InvalidOperationException($"Run '{run.RunId}' already exists.");
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
}
