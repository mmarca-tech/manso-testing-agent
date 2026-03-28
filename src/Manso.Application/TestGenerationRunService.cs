using Manso.Domain;
using Microsoft.Extensions.Logging;
using System.Text.Json;

namespace Manso.Application;

public sealed class TestGenerationRunService : ITestGenerationRunService
{
    private readonly IBackgroundRunQueue _backgroundRunQueue;
    private readonly IDocumentationResolver _documentationResolver;
    private readonly IGenerationContextBundleBuilder _generationContextBundleBuilder;
    private readonly IJiraContextService _jiraContextService;
    private readonly IRepositoryContextService _repositoryContextService;
    private readonly IRepositoryResolver _repositoryResolver;
    private readonly IXrayContextService _xrayContextService;
    private readonly IXrayTestCaseSyncService _xrayTestCaseSyncService;
    private readonly XrayRetrievalOptions _xrayOptions;
    private readonly IOutputValidator _outputValidator;
    private readonly IOutputWriter _outputWriter;
    private readonly IScenarioGenerator _scenarioGenerator;
    private readonly IRunIdFactory _runIdFactory;
    private readonly IRequestNormalizer _requestNormalizer;
    private readonly IRunStore _runStore;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<TestGenerationRunService> _logger;

    public TestGenerationRunService(
        IBackgroundRunQueue backgroundRunQueue,
        IDocumentationResolver documentationResolver,
        IGenerationContextBundleBuilder generationContextBundleBuilder,
        IJiraContextService jiraContextService,
        IRepositoryContextService repositoryContextService,
        IRepositoryResolver repositoryResolver,
        IXrayContextService xrayContextService,
        IXrayTestCaseSyncService xrayTestCaseSyncService,
        XrayRetrievalOptions xrayOptions,
        IOutputValidator outputValidator,
        IOutputWriter outputWriter,
        IScenarioGenerator scenarioGenerator,
        IRunIdFactory runIdFactory,
        IRequestNormalizer requestNormalizer,
        IRunStore runStore,
        TimeProvider timeProvider,
        ILogger<TestGenerationRunService> logger)
    {
        _backgroundRunQueue = backgroundRunQueue;
        _documentationResolver = documentationResolver;
        _generationContextBundleBuilder = generationContextBundleBuilder;
        _jiraContextService = jiraContextService;
        _repositoryContextService = repositoryContextService;
        _repositoryResolver = repositoryResolver;
        _xrayContextService = xrayContextService;
        _xrayTestCaseSyncService = xrayTestCaseSyncService;
        _xrayOptions = xrayOptions;
        _outputValidator = outputValidator;
        _outputWriter = outputWriter;
        _scenarioGenerator = scenarioGenerator;
        _runIdFactory = runIdFactory;
        _requestNormalizer = requestNormalizer;
        _runStore = runStore;
        _timeProvider = timeProvider;
        _logger = logger;
    }

    public async Task<RunAcceptedResponse> StartAsync(
        RawRunRequest request,
        string correlationId,
        CancellationToken ct)
    {
        ValidateIntakeRequest(request);
        await _requestNormalizer.NormalizeAsync(request, ct);

        var acceptedAtUtc = _timeProvider.GetUtcNow();
        var run = TestGenerationRun.Create(
                _runIdFactory.Create(),
                request,
                correlationId,
                acceptedAtUtc)
            .WithStage(new RunStageRecord(
                RunStageName.RequestAccepted,
                RunStageStatus.Succeeded,
                acceptedAtUtc,
                acceptedAtUtc,
                "Webhook request accepted and queued."));

        await _runStore.CreateAsync(run, ct);
        await _backgroundRunQueue.QueueAsync(run.RunId, ct);

        _logger.LogInformation(
            "Accepted test generation run {RunId} for issue {IssueKey}.",
            run.RunId,
            run.IssueKey);

        return new RunAcceptedResponse(
            run.RunId,
            run.Status,
            acceptedAtUtc,
            correlationId);
    }

    public async Task ExecuteAsync(string runId, CancellationToken ct)
    {
        var run = await _runStore.GetAsync(runId, ct);
        if (run is null)
        {
            _logger.LogWarning("Skipped background execution because run {RunId} was not found.", runId);
            return;
        }

        using var scope = _logger.BeginScope(new Dictionary<string, object?>
        {
            ["RunId"] = runId,
            ["IssueKey"] = run.IssueKey,
            ["CorrelationId"] = run.CorrelationId,
        });

        var startedAtUtc = _timeProvider.GetUtcNow();
        await _runStore.UpdateAsync(
            runId,
            current => current
                .MarkRunning(startedAtUtc)
                .WithStage(new RunStageRecord(
                    RunStageName.RequestNormalized,
                    RunStageStatus.Running,
                    startedAtUtc,
                    null,
                    "Normalizing request payload.")),
            ct);

        try
        {
            var normalization = await _requestNormalizer.NormalizeAsync(run.RawRequest, ct);
            await _runStore.UpdateAsync(
                runId,
                current =>
                {
                    var updated = current.WithNormalizedRequest(normalization.Request);
                    if (normalization.Warnings.Count > 0)
                    {
                        updated = updated.AddWarnings(normalization.Warnings);
                    }

                    return updated
                        .WithStage(new RunStageRecord(
                            RunStageName.RequestNormalized,
                            RunStageStatus.Succeeded,
                            startedAtUtc,
                            _timeProvider.GetUtcNow(),
                            "Request normalization completed."))
                        .MarkRunning(current.StartedAtUtc ?? startedAtUtc);
                },
                ct);

            _logger.LogInformation("Completed normalization stage for run {RunId}.", runId);

            var jiraStartedAtUtc = _timeProvider.GetUtcNow();
            await _runStore.UpdateAsync(
                runId,
                current => current.WithStage(new RunStageRecord(
                    RunStageName.JiraContextCollected,
                    RunStageStatus.Running,
                    jiraStartedAtUtc,
                    null,
                    "Fetching authoritative Jira context.")),
                ct);

            JiraIssueContext jiraContext;
            try
            {
                jiraContext = await _jiraContextService.BuildAsync(normalization.Request, ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed Jira context collection for run {RunId}.", runId);
                await FailRunAsync(
                    runId,
                    RunStageName.JiraContextCollected,
                    "jira_context_collection_failed",
                    ex.Message,
                    ct,
                    jiraStartedAtUtc);
                return;
            }

            var jiraCompletedAtUtc = _timeProvider.GetUtcNow();
            await _runStore.UpdateAsync(
                runId,
                current => current.WithStage(new RunStageRecord(
                    RunStageName.JiraContextCollected,
                    RunStageStatus.Succeeded,
                    jiraStartedAtUtc,
                    jiraCompletedAtUtc,
                    $"Fetched Jira issue context with {jiraContext.Comments.Count} selected comments.")),
                ct);

            var docsStartedAtUtc = _timeProvider.GetUtcNow();
            await _runStore.UpdateAsync(
                runId,
                current => current.WithStage(new RunStageRecord(
                    RunStageName.ConfluenceResolved,
                    RunStageStatus.Running,
                    docsStartedAtUtc,
                    null,
                    "Resolving explicit Confluence links.")),
                ct);

            DocumentationResolutionResult documentationResult;
            try
            {
                documentationResult = await _documentationResolver.ResolveAsync(jiraContext, normalization.Request, ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed documentation resolution for run {RunId}.", runId);
                await FailRunAsync(
                    runId,
                    RunStageName.ConfluenceResolved,
                    "documentation_resolution_failed",
                    ex.Message,
                    ct,
                    docsStartedAtUtc);
                return;
            }

            var docsCompletedAtUtc = _timeProvider.GetUtcNow();
            await _runStore.UpdateAsync(
                runId,
                current =>
                {
                    var updated = documentationResult.Warnings.Count > 0
                        ? current.AddWarnings(documentationResult.Warnings)
                        : current;

                    return updated
                        .WithStage(new RunStageRecord(
                            RunStageName.ConfluenceResolved,
                            RunStageStatus.Succeeded,
                            docsStartedAtUtc,
                            docsCompletedAtUtc,
                            $"Resolved {documentationResult.Documents.Count} explicit Confluence document(s)."))
                        .MarkRunning(current.StartedAtUtc ?? startedAtUtc);
                },
                ct);

            var repositoryStartedAtUtc = _timeProvider.GetUtcNow();
            await _runStore.UpdateAsync(
                runId,
                current => current.WithStage(new RunStageRecord(
                    RunStageName.RepositoryResolved,
                    RunStageStatus.Running,
                    repositoryStartedAtUtc,
                    null,
                    "Resolving repository and PR/branch target.")),
                ct);

            RepositoryTarget? repositoryTarget = null;
            RepositoryContextBundle? repositoryContext = null;
            try
            {
                repositoryTarget = await _repositoryResolver.ResolveAsync(jiraContext, normalization.Request, ct);
            }
            catch (RepositoryContextUnavailableException ex)
            {
                _logger.LogInformation(
                    "Repository context unavailable for run {RunId}; continuing without repo diff. Reason: {Message}",
                    runId,
                    ex.Message);

                var repositorySkippedAtUtc = _timeProvider.GetUtcNow();
                await _runStore.UpdateAsync(
                    runId,
                    current => current
                        .AddWarning(new RunWarning(
                            "repository_context_unavailable",
                            ex.Message))
                        .WithStage(new RunStageRecord(
                            RunStageName.RepositoryResolved,
                            RunStageStatus.Skipped,
                            repositoryStartedAtUtc,
                            repositorySkippedAtUtc,
                            ex.Message))
                        .WithStage(new RunStageRecord(
                            RunStageName.CodeContextCollected,
                            RunStageStatus.Skipped,
                            repositorySkippedAtUtc,
                            repositorySkippedAtUtc,
                            "Skipped because no repository PR or branch context was available.")),
                    ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed repository resolution for run {RunId}.", runId);
                await FailRunAsync(
                    runId,
                    RunStageName.RepositoryResolved,
                    "repository_resolution_failed",
                    ex.Message,
                    ct,
                    repositoryStartedAtUtc);
                return;
            }

            if (repositoryTarget is not null)
            {
                var repositoryCompletedAtUtc = _timeProvider.GetUtcNow();
                await _runStore.UpdateAsync(
                    runId,
                    current => current
                        .WithRepositoryTarget(repositoryTarget)
                        .WithStage(new RunStageRecord(
                            RunStageName.RepositoryResolved,
                            RunStageStatus.Succeeded,
                            repositoryStartedAtUtc,
                            repositoryCompletedAtUtc,
                            repositoryTarget.PullRequestIds.Count > 1
                                ? $"Resolved repository '{repositoryTarget.Alias}' from {repositoryTarget.PullRequestIds.Count} merged Jira pull requests."
                                : repositoryTarget.PullRequestId is not null
                                ? $"Resolved repository '{repositoryTarget.Alias}' from PR {repositoryTarget.PullRequestId}."
                                : $"Resolved repository '{repositoryTarget.Alias}' from branch '{repositoryTarget.BranchName}'.")),
                    ct);

                var codeContextStartedAtUtc = _timeProvider.GetUtcNow();
                await _runStore.UpdateAsync(
                    runId,
                    current => current.WithStage(new RunStageRecord(
                        RunStageName.CodeContextCollected,
                        RunStageStatus.Running,
                        codeContextStartedAtUtc,
                        null,
                        "Collecting changed files, diff context, and neighboring tests.")),
                    ct);

                try
                {
                    repositoryContext = await _repositoryContextService.BuildAsync(repositoryTarget, normalization.Request, ct);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed code context collection for run {RunId}.", runId);
                    await FailRunAsync(
                        runId,
                        RunStageName.CodeContextCollected,
                        "code_context_collection_failed",
                        ex.Message,
                        ct,
                        codeContextStartedAtUtc);
                    return;
                }

                var codeContextCompletedAtUtc = _timeProvider.GetUtcNow();
                await _runStore.UpdateAsync(
                    runId,
                    current =>
                    {
                        var updated = repositoryContext.Warnings.Count > 0
                            ? current.AddWarnings(repositoryContext.Warnings)
                            : current;

                        return updated
                            .WithStage(new RunStageRecord(
                                RunStageName.CodeContextCollected,
                                RunStageStatus.Succeeded,
                                codeContextStartedAtUtc,
                                codeContextCompletedAtUtc,
                                $"Collected diff context for {repositoryContext.ChangedFiles.Count} changed file(s) and {repositoryContext.NeighboringTests.Count} neighboring test file(s)."));
                    },
                    ct);
            }

            var xrayStartedAtUtc = _timeProvider.GetUtcNow();
            await _runStore.UpdateAsync(
                runId,
                current => current.WithStage(new RunStageRecord(
                    RunStageName.XrayContextCollected,
                    RunStageStatus.Running,
                    xrayStartedAtUtc,
                    null,
                    "Collecting neighboring Xray test cases.")),
                ct);

            XrayContextBundle xrayContext;
            try
            {
                xrayContext = await _xrayContextService.BuildAsync(
                    normalization.Request,
                    jiraContext,
                    repositoryTarget,
                    repositoryContext,
                    ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed Xray context collection for run {RunId}.", runId);
                await FailRunAsync(
                    runId,
                    RunStageName.XrayContextCollected,
                    "xray_context_collection_failed",
                    ex.Message,
                    ct,
                    xrayStartedAtUtc);
                return;
            }

            var xrayCompletedAtUtc = _timeProvider.GetUtcNow();
            await _runStore.UpdateAsync(
                runId,
                current => current
                    .AddWarnings(xrayContext.Warnings)
                    .WithStage(new RunStageRecord(
                        RunStageName.XrayContextCollected,
                        RunStageStatus.Succeeded,
                        xrayStartedAtUtc,
                        xrayCompletedAtUtc,
                        $"Collected {xrayContext.NeighboringTests.Count} neighboring Xray test(s).")),
                ct);

            var contextBundleStartedAtUtc = _timeProvider.GetUtcNow();
            await _runStore.UpdateAsync(
                runId,
                current => current.WithStage(new RunStageRecord(
                    RunStageName.ContextBundleBuilt,
                    RunStageStatus.Running,
                    contextBundleStartedAtUtc,
                    null,
                    "Building generation context bundle.")),
                ct);

            GenerationContextBundle contextBundle;
            try
            {
                contextBundle = await _generationContextBundleBuilder.BuildAsync(
                    normalization.Request,
                    jiraContext,
                    documentationResult.Documents,
                    repositoryTarget,
                    repositoryContext,
                    xrayContext,
                    ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed generation context bundle build for run {RunId}.", runId);
                await FailRunAsync(
                    runId,
                    RunStageName.ContextBundleBuilt,
                    "generation_context_build_failed",
                    ex.Message,
                    ct,
                    contextBundleStartedAtUtc);
                return;
            }

            var contextBundleCompletedAtUtc = _timeProvider.GetUtcNow();
            await _runStore.UpdateAsync(
                runId,
                current =>
                {
                    var updated = contextBundle.Warnings.Count > 0
                        ? current.AddWarnings(contextBundle.Warnings)
                        : current;

                    return updated
                        .WithStage(new RunStageRecord(
                            RunStageName.ContextBundleBuilt,
                            RunStageStatus.Succeeded,
                            contextBundleStartedAtUtc,
                            contextBundleCompletedAtUtc,
                            $"Built {contextBundle.Sections.Count} context sections using {contextBundle.DocumentationDocumentCount} doc(s), {contextBundle.ChangedFileCount} changed file(s), {contextBundle.NeighboringTestCount} neighboring repo test file(s), and {contextBundle.XrayNeighboringTestCount} neighboring Xray test(s)."))
                        .MarkRunning(current.StartedAtUtc ?? startedAtUtc);
                },
                ct);

            var scenariosStartedAtUtc = _timeProvider.GetUtcNow();
            await _runStore.UpdateAsync(
                runId,
                current => current.WithStage(new RunStageRecord(
                    RunStageName.ScenariosGenerated,
                    RunStageStatus.Running,
                    scenariosStartedAtUtc,
                    null,
                    "Generating candidate test scenarios from the context bundle.")),
                ct);

            GeneratedScenarioBundle scenarioBundle;
            try
            {
                scenarioBundle = await _scenarioGenerator.GenerateAsync(contextBundle, ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed scenario generation for run {RunId}.", runId);
                await FailRunAsync(
                    runId,
                    RunStageName.ScenariosGenerated,
                    "scenario_generation_failed",
                    ex.Message,
                    ct,
                    scenariosStartedAtUtc);
                return;
            }

            var scenariosCompletedAtUtc = _timeProvider.GetUtcNow();
            await _runStore.UpdateAsync(
                runId,
                current => current
                    .AddStoredArtifact(new StoredArtifact(
                        "ScenarioJson",
                        "generated-scenarios.json",
                        "application/json",
                        $"run://{runId}/generated-scenarios.json",
                        scenarioBundle.RawJson))
                    .WithStage(new RunStageRecord(
                        RunStageName.ScenariosGenerated,
                        RunStageStatus.Succeeded,
                        scenariosStartedAtUtc,
                        scenariosCompletedAtUtc,
                        $"Generated {scenarioBundle.Scenarios.Count} scenario(s) using {scenarioBundle.ModelProvider}/{scenarioBundle.ModelName}.")),
                ct);

            var validationStartedAtUtc = _timeProvider.GetUtcNow();
            await _runStore.UpdateAsync(
                runId,
                current => current.WithStage(new RunStageRecord(
                    RunStageName.OutputsValidated,
                    RunStageStatus.Running,
                    validationStartedAtUtc,
                    null,
                    "Running deterministic output validation.")),
                ct);

            ValidationResult validationResult;
            try
            {
                validationResult = await _outputValidator.ValidateAsync(contextBundle, scenarioBundle, null, ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed validation stage for run {RunId}.", runId);
                await FailRunAsync(
                    runId,
                    RunStageName.OutputsValidated,
                    "output_validation_failed",
                    ex.Message,
                    ct,
                    validationStartedAtUtc);
                return;
            }

            var validationCompletedAtUtc = _timeProvider.GetUtcNow();
            var validationJson = JsonSerializer.Serialize(validationResult);
            await _runStore.UpdateAsync(
                runId,
                current => current
                    .AddStoredArtifact(new StoredArtifact(
                        "ValidationReportJson",
                        "validation-report.json",
                        "application/json",
                        $"run://{runId}/validation-report.json",
                        validationJson))
                    .AddWarnings(validationResult.Messages
                        .Where(message => message.Severity.Equals("Warning", StringComparison.OrdinalIgnoreCase))
                        .Select(message => new RunWarning(
                            message.Code,
                            message.Message)))
                    .AddErrors(validationResult.Messages
                        .Where(message => message.Severity.Equals("Error", StringComparison.OrdinalIgnoreCase))
                        .Select(message => new RunError(
                            message.Code,
                            message.Message,
                            RunStageName.OutputsValidated)))
                    .WithStage(new RunStageRecord(
                        RunStageName.OutputsValidated,
                        RunStageStatus.Succeeded,
                        validationStartedAtUtc,
                        validationCompletedAtUtc,
                        $"Validation completed with outcome {validationResult.Outcome} and {validationResult.Messages.Count} message(s).")),
                ct);

            if (ShouldAutoSyncXrayScenarioTests(normalization.Request, validationResult, _xrayOptions))
            {
                var testsGeneratedStartedAtUtc = _timeProvider.GetUtcNow();
                await _runStore.UpdateAsync(
                    runId,
                    current => current.WithStage(new RunStageRecord(
                        RunStageName.TestsGenerated,
                        RunStageStatus.Running,
                        testsGeneratedStartedAtUtc,
                        null,
                        "Synchronizing generated scenarios to Xray test cases.")),
                    ct);

                XrayScenarioSyncResult xraySyncResult;
                try
                {
                    xraySyncResult = await _xrayTestCaseSyncService.SyncAsync(
                        normalization.Request,
                        jiraContext,
                        scenarioBundle,
                        xrayContext,
                        ct);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed Xray test-case sync for run {RunId}.", runId);
                    await FailRunAsync(
                        runId,
                        RunStageName.TestsGenerated,
                        "xray_test_case_sync_failed",
                        ex.Message,
                        ct,
                        testsGeneratedStartedAtUtc);
                    return;
                }

                var testsGeneratedCompletedAtUtc = _timeProvider.GetUtcNow();
                await _runStore.UpdateAsync(
                    runId,
                    current => current
                        .AddStoredArtifact(new StoredArtifact(
                            "XraySyncResultJson",
                            "xray-sync-result.json",
                            "application/json",
                            $"run://{runId}/xray-sync-result.json",
                            JsonSerializer.Serialize(xraySyncResult)))
                        .AddWarnings(xraySyncResult.Warnings)
                        .WithStage(new RunStageRecord(
                            RunStageName.TestsGenerated,
                            RunStageStatus.Succeeded,
                            testsGeneratedStartedAtUtc,
                            testsGeneratedCompletedAtUtc,
                            $"Synchronized {xraySyncResult.Items.Count(item => item.Action is "Created" or "Updated")} scenario(s) to Xray with {xraySyncResult.Warnings.Count} warning(s).")),
                    ct);
            }
            else
            {
                var testsGeneratedSkippedAtUtc = _timeProvider.GetUtcNow();
                await _runStore.UpdateAsync(
                    runId,
                    current => current.WithStage(new RunStageRecord(
                        RunStageName.TestsGenerated,
                        RunStageStatus.Skipped,
                        testsGeneratedSkippedAtUtc,
                        testsGeneratedSkippedAtUtc,
                        "Skipped because automatic Xray test-case sync is not enabled for this run.")),
                    ct);
            }

            var outputsWrittenStartedAtUtc = _timeProvider.GetUtcNow();
            await _runStore.UpdateAsync(
                runId,
                current => current.WithStage(new RunStageRecord(
                    RunStageName.OutputsWritten,
                    RunStageStatus.Running,
                    outputsWrittenStartedAtUtc,
                    null,
                    "Writing output artifacts and write result.")),
                ct);

            OutputWriteResult writeOutput;
            try
            {
                writeOutput = await _outputWriter.WriteAsync(contextBundle, scenarioBundle, null, validationResult, ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed outputs-written stage for run {RunId}.", runId);
                await FailRunAsync(
                    runId,
                    RunStageName.OutputsWritten,
                    "outputs_written_failed",
                    ex.Message,
                    ct,
                    outputsWrittenStartedAtUtc);
                return;
            }

            var outputsWrittenCompletedAtUtc = _timeProvider.GetUtcNow();
            await _runStore.UpdateAsync(
                runId,
                current => current
                    .AddStoredArtifacts(writeOutput.Artifacts)
                    .WithStage(new RunStageRecord(
                        RunStageName.OutputsWritten,
                        RunStageStatus.Succeeded,
                        outputsWrittenStartedAtUtc,
                        outputsWrittenCompletedAtUtc,
                        $"Outputs written with status {writeOutput.Result.Status} and {writeOutput.Artifacts.Count} artifact(s)."))
                    .MarkCompleted(
                        validationResult.Outcome == ValidationOutcome.Fail
                            ? RunStatus.Failed
                            : validationResult.Outcome == ValidationOutcome.PassWithWarnings
                            ? RunStatus.PartialSuccess
                            : RunStatus.Succeeded,
                        outputsWrittenCompletedAtUtc),
                ct);
        }
        catch (RequestValidationException ex)
        {
            await FailRunAsync(
                runId,
                RunStageName.RequestNormalized,
                "request_validation_failed",
                ex.Message,
                ct,
                startedAtUtc);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Unexpected failure while executing run {RunId}.", runId);
            await FailRunAsync(
                runId,
                RunStageName.RequestNormalized,
                "unexpected_execution_failure",
                "An unexpected error occurred while executing the run.",
                ct,
                startedAtUtc);
        }
    }

    public Task<TestGenerationRun?> GetAsync(string runId, CancellationToken ct)
        => _runStore.GetAsync(runId, ct);

    private async Task FailRunAsync(
        string runId,
        RunStageName stageName,
        string errorCode,
        string message,
        CancellationToken ct,
        DateTimeOffset? stageStartedAtUtc = null)
    {
        var failedAtUtc = _timeProvider.GetUtcNow();
        await _runStore.UpdateAsync(
            runId,
            current => current
                .WithStage(new RunStageRecord(
                    stageName,
                    RunStageStatus.Failed,
                    stageStartedAtUtc ?? current.StartedAtUtc ?? failedAtUtc,
                    failedAtUtc,
                    message))
                .AddError(new RunError(errorCode, message, stageName))
                .MarkCompleted(RunStatus.Failed, failedAtUtc),
            ct);
    }

    private static void ValidateIntakeRequest(RawRunRequest request)
    {
        if (request is null)
        {
            throw new RequestValidationException("Request body is required.");
        }

        if (request.Issue is null)
        {
            throw new RequestValidationException("issue is required.", "issue");
        }

        if (request.TriggerInputs is null)
        {
            throw new RequestValidationException("triggerInputs is required.", "triggerInputs");
        }

        if (request.IssueFields is null)
        {
            throw new RequestValidationException("issueFields is required.", "issueFields");
        }

        if (request.RequestedBy is null)
        {
            throw new RequestValidationException("requestedBy is required.", "requestedBy");
        }

        ValidateRequired(request.RequestSource, "requestSource");
        ValidateRequired(request.TriggerType, "triggerType");
        ValidateRequired(request.Issue.Key, "issue.key");
        ValidateRequired(request.Issue.Id, "issue.id");
        ValidateRequired(request.Issue.ProjectKey, "issue.projectKey");
        ValidateRequired(request.Issue.Summary, "issue.summary");
        ValidateRequired(request.Issue.Url, "issue.url");

        if (!Uri.TryCreate(request.Issue.Url, UriKind.Absolute, out _))
        {
            throw new RequestValidationException(
                "issue.url must be a valid absolute URL.",
                "issue.url",
                request.Issue.Url);
        }
    }

    private static void ValidateRequired(string? value, string fieldName)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new RequestValidationException($"{fieldName} is required.", fieldName);
        }
    }

    private static bool ShouldAutoSyncXrayScenarioTests(
        NormalizedRunRequest request,
        ValidationResult validationResult,
        XrayRetrievalOptions xrayOptions)
        => xrayOptions.EnableScenarioAutoUpsert &&
           request.GenerationMode == GenerationMode.TestCasesOnly &&
           request.WorkflowPass == WorkflowPass.ScenarioDesign &&
           (validationResult.Outcome == ValidationOutcome.Pass ||
            validationResult.Outcome == ValidationOutcome.PassWithWarnings);
}
