using Manso.Application;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Manso.Infrastructure;

public sealed class RunExecutionBackgroundService : BackgroundService
{
    private readonly IBackgroundRunQueue _backgroundRunQueue;
    private readonly ITestGenerationRunService _runService;
    private readonly ILogger<RunExecutionBackgroundService> _logger;

    public RunExecutionBackgroundService(
        IBackgroundRunQueue backgroundRunQueue,
        ITestGenerationRunService runService,
        ILogger<RunExecutionBackgroundService> logger)
    {
        _backgroundRunQueue = backgroundRunQueue;
        _runService = runService;
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
            }
        }
    }
}
