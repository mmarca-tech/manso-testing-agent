using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Manso.Infrastructure;

public sealed class RunExecutionBackgroundService : BackgroundService
{
    private readonly IBackgroundRunQueue _backgroundRunQueue;
    private readonly ITestGenerationRunService _runService;
    private readonly IRunStore _runStore;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<RunExecutionBackgroundService> _logger;

    public RunExecutionBackgroundService(
        IBackgroundRunQueue backgroundRunQueue,
        ITestGenerationRunService runService,
        IRunStore runStore,
        TimeProvider timeProvider,
        ILogger<RunExecutionBackgroundService> logger)
    {
        _backgroundRunQueue = backgroundRunQueue;
        _runService = runService;
        _runStore = runStore;
        _timeProvider = timeProvider;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var runId = await _backgroundRunQueue.DequeueAsync(stoppingToken);

            try
            {
                await _runService.ExecuteAsync(runId, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Background execution failed for run {RunId}.", runId);
                await TryMarkRunFailedAsync(runId, ex, stoppingToken);
            }
        }
    }

    private async Task TryMarkRunFailedAsync(string runId, Exception exception, CancellationToken ct)
    {
        try
        {
            await _runStore.UpdateAsync(
                runId,
                run =>
                {
                    if (run.Status is RunStatus.Succeeded or RunStatus.PartialSuccess or RunStatus.Failed or RunStatus.Cancelled)
                    {
                        return run;
                    }

                    var failureTimestamp = _timeProvider.GetUtcNow();
                    var failedRun = run with
                    {
                        StartedAtUtc = run.StartedAtUtc ?? failureTimestamp,
                    };

                    failedRun = failedRun.AddError(new RunError(
                        "background_execution_failed",
                        exception.Message,
                        null));

                    return failedRun.MarkCompleted(RunStatus.Failed, failureTimestamp);
                },
                ct);
        }
        catch (Exception updateException) when (updateException is not OperationCanceledException)
        {
            _logger.LogError(
                updateException,
                "Failed to persist fallback run failure state for run {RunId} after background execution error.",
                runId);
        }
    }
}
