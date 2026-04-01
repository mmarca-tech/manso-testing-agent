using Manso.Domain;
using Microsoft.Extensions.Logging;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Manso.Application;

public sealed class TestGenerationRunService : ITestGenerationRunService
{
    private static readonly JsonSerializerOptions ArtifactJsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
    };

    private static readonly (TestScope Scope, string[] Keywords, int Weight)[] TestScopeSignals =
    [
        (TestScope.E2E, ["e2e", "endtoend", "end-to-end"], 4),
        (TestScope.Ui, ["playwright", "cypress", "selenium", "frontend", "browser", "/ui/"], 3),
        (TestScope.Integration, ["integration", "/integration/"], 3),
        (TestScope.Api, ["api", "controller", "endpoint", "contract", "http", "webapplicationfactory", "/api/"], 3),
        (TestScope.Unit, ["unit", "/unit/"], 2),
    ];

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
        await StartStageAsync(
            runId,
            RunStageName.RequestNormalized,
            startedAtUtc,
            "Normalizing request payload.",
            ct,
            markRunning: true);

        try
        {
            var normalization = await _requestNormalizer.NormalizeAsync(run.RawRequest, ct);
            var effectiveRequest = normalization.Request;
            await CompleteStageAsync(
                runId,
                RunStageName.RequestNormalized,
                startedAtUtc,
                "Request normalization completed.",
                ct,
                current =>
                {
                    var updated = current.WithNormalizedRequest(effectiveRequest);
                    if (normalization.Warnings.Count > 0)
                    {
                        updated = updated.AddWarnings(normalization.Warnings);
                    }

                    return updated.MarkRunning(current.StartedAtUtc ?? startedAtUtc);
                });

            _logger.LogInformation("Completed normalization stage for run {RunId}.", runId);

            var jiraStartedAtUtc = _timeProvider.GetUtcNow();
            await StartStageAsync(
                runId,
                RunStageName.JiraContextCollected,
                jiraStartedAtUtc,
                "Fetching authoritative Jira context.",
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
            await CompleteStageAsync(
                runId,
                RunStageName.JiraContextCollected,
                jiraStartedAtUtc,
                $"Fetched Jira issue context with {jiraContext.Comments.Count} selected comments.",
                ct,
                current => current);

            var docsStartedAtUtc = _timeProvider.GetUtcNow();
            await StartStageAsync(
                runId,
                RunStageName.ConfluenceResolved,
                docsStartedAtUtc,
                "Resolving explicit Confluence links.",
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
            await CompleteStageAsync(
                runId,
                RunStageName.ConfluenceResolved,
                docsStartedAtUtc,
                $"Resolved {documentationResult.Documents.Count} explicit Confluence document(s).",
                ct,
                current =>
                {
                    var updated = documentationResult.Warnings.Count > 0
                        ? current.AddWarnings(documentationResult.Warnings)
                        : current;

                    return updated.MarkRunning(current.StartedAtUtc ?? startedAtUtc);
                });

            var repositoryStartedAtUtc = _timeProvider.GetUtcNow();
            await StartStageAsync(
                runId,
                RunStageName.RepositoryResolved,
                repositoryStartedAtUtc,
                "Resolving repository and PR/branch target.",
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
                await SkipStageAsync(
                    runId,
                    RunStageName.RepositoryResolved,
                    repositoryStartedAtUtc,
                    ex.Message,
                    ct,
                    current => current.AddWarning(new RunWarning(
                        "repository_context_unavailable",
                        ex.Message)));
                await SkipStageAsync(
                    runId,
                    RunStageName.CodeContextCollected,
                    repositorySkippedAtUtc,
                    "Skipped because no repository PR or branch context was available.",
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
                await CompleteStageAsync(
                    runId,
                    RunStageName.RepositoryResolved,
                    repositoryStartedAtUtc,
                    DescribeRepositoryResolution(repositoryTarget),
                    ct,
                    current => current.WithRepositoryTarget(repositoryTarget));

                var codeContextStartedAtUtc = _timeProvider.GetUtcNow();
                await StartStageAsync(
                    runId,
                    RunStageName.CodeContextCollected,
                    codeContextStartedAtUtc,
                    "Collecting changed files, diff context, and neighboring tests.",
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
                await CompleteStageAsync(
                    runId,
                    RunStageName.CodeContextCollected,
                    codeContextStartedAtUtc,
                    $"Collected diff context for {repositoryContext.ChangedFiles.Count} changed file(s) and {repositoryContext.NeighboringTests.Count} neighboring test file(s).",
                    ct,
                    current => repositoryContext.Warnings.Count > 0
                        ? current.AddWarnings(repositoryContext.Warnings)
                        : current);
            }

            effectiveRequest = ApplyRuntimeInferences(effectiveRequest, repositoryTarget, repositoryContext);
            if (!ReferenceEquals(effectiveRequest, normalization.Request))
            {
                await _runStore.UpdateAsync(
                    runId,
                    current => current.WithNormalizedRequest(effectiveRequest),
                    ct);
            }

            var xrayStartedAtUtc = _timeProvider.GetUtcNow();
            await StartStageAsync(
                runId,
                RunStageName.XrayContextCollected,
                xrayStartedAtUtc,
                "Collecting neighboring Xray test cases.",
                ct);

            XrayContextBundle xrayContext;
                try
                {
                    xrayContext = await _xrayContextService.BuildAsync(
                        effectiveRequest,
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
            await CompleteStageAsync(
                runId,
                RunStageName.XrayContextCollected,
                xrayStartedAtUtc,
                $"Collected {xrayContext.NeighboringTests.Count} linked and neighboring Xray test(s).",
                ct,
                current => current.AddWarnings(xrayContext.Warnings));

            var contextBundleStartedAtUtc = _timeProvider.GetUtcNow();
            await StartStageAsync(
                runId,
                RunStageName.ContextBundleBuilt,
                contextBundleStartedAtUtc,
                "Building generation context bundle.",
                ct);

            GenerationContextBundle contextBundle;
            try
            {
                contextBundle = await _generationContextBundleBuilder.BuildAsync(
                    effectiveRequest,
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
            var promptPreview = _scenarioGenerator.PreviewPrompt(contextBundle);
            await CompleteStageAsync(
                runId,
                RunStageName.ContextBundleBuilt,
                contextBundleStartedAtUtc,
                $"Built {contextBundle.Sections.Count} context sections using {contextBundle.DocumentationDocumentCount} doc(s), {contextBundle.ChangedFileCount} changed file(s), {contextBundle.NeighboringTestCount} neighboring repo test file(s), and {contextBundle.XrayNeighboringTestCount} linked and neighboring Xray test(s).",
                ct,
                current =>
                {
                    var updated = contextBundle.Warnings.Count > 0
                        ? current.AddWarnings(contextBundle.Warnings)
                        : current;

                    return updated
                        .AddStoredArtifact(BuildContextBundleArtifact(runId, contextBundle))
                        .AddStoredArtifact(BuildPromptArtifact(runId, promptPreview))
                        .MarkRunning(current.StartedAtUtc ?? startedAtUtc);
                });

            if (effectiveRequest.DryRun)
            {
                var dryRunCompletedAtUtc = _timeProvider.GetUtcNow();
                await _runStore.UpdateAsync(
                    runId,
                    current => current
                        .WithStage(new RunStageRecord(
                            RunStageName.ScenariosGenerated,
                            RunStageStatus.Skipped,
                            dryRunCompletedAtUtc,
                            dryRunCompletedAtUtc,
                            "Dry run enabled; the generation context bundle and final LLM prompt were stored without sending a request to the LLM."))
                        .WithStage(new RunStageRecord(
                            RunStageName.TestsGenerated,
                            RunStageStatus.Skipped,
                            dryRunCompletedAtUtc,
                            dryRunCompletedAtUtc,
                            "Skipped because dry run mode does not generate or synchronize test cases."))
                        .WithStage(new RunStageRecord(
                            RunStageName.OutputsValidated,
                            RunStageStatus.Skipped,
                            dryRunCompletedAtUtc,
                            dryRunCompletedAtUtc,
                            "Skipped because dry run mode does not produce generated scenarios to validate."))
                        .WithStage(new RunStageRecord(
                            RunStageName.OutputsWritten,
                            RunStageStatus.Skipped,
                            dryRunCompletedAtUtc,
                            dryRunCompletedAtUtc,
                            "Skipped because dry run mode only stores preview artifacts."))
                        .MarkCompleted(RunStatus.Succeeded, dryRunCompletedAtUtc),
                    ct);
                return;
            }

            var scenariosStartedAtUtc = _timeProvider.GetUtcNow();
            await StartStageAsync(
                runId,
                RunStageName.ScenariosGenerated,
                scenariosStartedAtUtc,
                "Generating candidate test scenarios from the context bundle.",
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
            await CompleteStageAsync(
                runId,
                RunStageName.ScenariosGenerated,
                scenariosStartedAtUtc,
                $"Generated {scenarioBundle.Scenarios.Count} scenario(s) using {scenarioBundle.ModelProvider}/{scenarioBundle.ModelName}.",
                ct,
                current => current.AddStoredArtifact(CreateJsonArtifact(
                    runId,
                    "ScenarioJson",
                    "generated-scenarios.json",
                    scenarioBundle.RawJson)));

            var validationStartedAtUtc = _timeProvider.GetUtcNow();
            await StartStageAsync(
                runId,
                RunStageName.OutputsValidated,
                validationStartedAtUtc,
                "Running deterministic output validation.",
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
            await CompleteStageAsync(
                runId,
                RunStageName.OutputsValidated,
                validationStartedAtUtc,
                $"Validation completed with outcome {validationResult.Outcome} and {validationResult.Messages.Count} message(s).",
                ct,
                current => ApplyValidationResult(current, runId, validationResult, validationJson));

            if (ShouldAutoSyncXrayScenarioTests(effectiveRequest, validationResult, _xrayOptions))
            {
                var testsGeneratedStartedAtUtc = _timeProvider.GetUtcNow();
                await StartStageAsync(
                    runId,
                    RunStageName.TestsGenerated,
                    testsGeneratedStartedAtUtc,
                    "Synchronizing generated scenarios to Xray test cases.",
                    ct);

                XrayScenarioSyncResult xraySyncResult;
                try
                {
                    xraySyncResult = await _xrayTestCaseSyncService.SyncAsync(
                        effectiveRequest,
                        jiraContext,
                        scenarioBundle,
                        repositoryContext,
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
                await CompleteStageAsync(
                    runId,
                    RunStageName.TestsGenerated,
                    testsGeneratedStartedAtUtc,
                    $"Synchronized {xraySyncResult.Items.Count(item => item.Action is "Created" or "Updated")} scenario(s) to Xray with {xraySyncResult.Warnings.Count} warning(s).",
                    ct,
                    current => current
                        .AddStoredArtifact(CreateJsonArtifact(
                            runId,
                            "XraySyncResultJson",
                            "xray-sync-result.json",
                            JsonSerializer.Serialize(xraySyncResult)))
                        .AddWarnings(xraySyncResult.Warnings));
            }
            else
            {
                var testsGeneratedSkippedAtUtc = _timeProvider.GetUtcNow();
                await SkipStageAsync(
                    runId,
                    RunStageName.TestsGenerated,
                    testsGeneratedSkippedAtUtc,
                    "Skipped because automatic Xray test-case sync is not enabled for this run.",
                    ct);
            }

            var outputsWrittenStartedAtUtc = _timeProvider.GetUtcNow();
            await StartStageAsync(
                runId,
                RunStageName.OutputsWritten,
                outputsWrittenStartedAtUtc,
                "Writing output artifacts and write result.",
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
            await CompleteStageAsync(
                runId,
                RunStageName.OutputsWritten,
                outputsWrittenStartedAtUtc,
                $"Outputs written with status {writeOutput.Result.Status} and {writeOutput.Artifacts.Count} artifact(s).",
                ct,
                current => current
                    .AddStoredArtifacts(writeOutput.Artifacts)
                    .MarkCompleted(
                        DetermineRunStatus(validationResult.Outcome),
                        outputsWrittenCompletedAtUtc));
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
                .WithStage(CreateStageRecord(
                    stageName,
                    RunStageStatus.Failed,
                    stageStartedAtUtc ?? current.StartedAtUtc ?? failedAtUtc,
                    failedAtUtc,
                    message))
                .AddError(new RunError(errorCode, message, stageName))
                .MarkCompleted(RunStatus.Failed, failedAtUtc),
            ct);
    }

    private Task StartStageAsync(
        string runId,
        RunStageName stageName,
        DateTimeOffset startedAtUtc,
        string details,
        CancellationToken ct,
        bool markRunning = false)
        => _runStore.UpdateAsync(
            runId,
            current =>
            {
                var updated = markRunning
                    ? current.MarkRunning(startedAtUtc)
                    : current;
                return updated.WithStage(CreateStageRecord(stageName, RunStageStatus.Running, startedAtUtc, null, details));
            },
            ct);

    private Task CompleteStageAsync(
        string runId,
        RunStageName stageName,
        DateTimeOffset startedAtUtc,
        string details,
        CancellationToken ct,
        Func<TestGenerationRun, TestGenerationRun> mutate)
    {
        var completedAtUtc = _timeProvider.GetUtcNow();
        return _runStore.UpdateAsync(
            runId,
            current => mutate(current).WithStage(CreateStageRecord(stageName, RunStageStatus.Succeeded, startedAtUtc, completedAtUtc, details)),
            ct);
    }

    private Task SkipStageAsync(
        string runId,
        RunStageName stageName,
        DateTimeOffset timestampUtc,
        string details,
        CancellationToken ct,
        Func<TestGenerationRun, TestGenerationRun>? mutate = null)
        => _runStore.UpdateAsync(
            runId,
            current =>
            {
                var updated = mutate is null ? current : mutate(current);
                return updated.WithStage(CreateStageRecord(stageName, RunStageStatus.Skipped, timestampUtc, timestampUtc, details));
            },
            ct);

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

        if (request.RequestedBy is null)
        {
            throw new RequestValidationException("requestedBy is required.", "requestedBy");
        }

        ValidateRequired(request.RequestSource, "requestSource");
        ValidateRequired(request.TriggerType, "triggerType");
        ValidateRequired(request.Issue.Key, "issue.key");
        ValidateRequired(request.Issue.Id, "issue.id");
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
        => !request.DryRun &&
           xrayOptions.EnableScenarioAutoUpsert &&
           request.GenerationMode == GenerationMode.TestCasesOnly &&
           request.WorkflowPass == WorkflowPass.ScenarioDesign &&
           (validationResult.Outcome == ValidationOutcome.Pass ||
            validationResult.Outcome == ValidationOutcome.PassWithWarnings);

    private static StoredArtifact BuildContextBundleArtifact(string runId, GenerationContextBundle contextBundle)
        => CreateJsonArtifact(
            runId,
            "GenerationContextBundleJson",
            "generation-context-bundle.json",
            JsonSerializer.Serialize(contextBundle, ArtifactJsonOptions));

    private static StoredArtifact BuildPromptArtifact(string runId, LlmPromptRequest promptRequest)
        => CreateJsonArtifact(
            runId,
            "LlmPromptJson",
            "llm-prompt.json",
            JsonSerializer.Serialize(promptRequest, ArtifactJsonOptions));

    private static StoredArtifact CreateJsonArtifact(
        string runId,
        string type,
        string name,
        string content)
        => new(
            type,
            name,
            "application/json",
            $"run://{runId}/{name}",
            content);

    private static bool IsWarning(ValidationMessage message)
        => message.Severity.Equals("Warning", StringComparison.OrdinalIgnoreCase);

    private static bool IsError(ValidationMessage message)
        => message.Severity.Equals("Error", StringComparison.OrdinalIgnoreCase);

    private static TestGenerationRun ApplyValidationResult(
        TestGenerationRun run,
        string runId,
        ValidationResult validationResult,
        string validationJson)
        => run
            .AddStoredArtifact(CreateJsonArtifact(
                runId,
                "ValidationReportJson",
                "validation-report.json",
                validationJson))
            .AddWarnings(validationResult.Messages
                .Where(IsWarning)
                .Select(message => new RunWarning(message.Code, message.Message)))
            .AddErrors(validationResult.Messages
                .Where(IsError)
                .Select(message => new RunError(message.Code, message.Message, RunStageName.OutputsValidated)));

    private static RunStatus DetermineRunStatus(ValidationOutcome outcome)
        => outcome == ValidationOutcome.Fail
            ? RunStatus.Failed
            : outcome == ValidationOutcome.PassWithWarnings
                ? RunStatus.PartialSuccess
                : RunStatus.Succeeded;

    private static string DescribeRepositoryResolution(RepositoryTarget repositoryTarget)
        => repositoryTarget.EffectivePullRequestIds.Count > 1
            ? $"Resolved repository '{repositoryTarget.Alias}' from {repositoryTarget.EffectivePullRequestIds.Count} merged Jira pull requests."
            : repositoryTarget.PrimaryPullRequestId is not null
                ? $"Resolved repository '{repositoryTarget.Alias}' from PR {repositoryTarget.PrimaryPullRequestId}."
                : $"Resolved repository '{repositoryTarget.Alias}' from branch '{repositoryTarget.BranchName}'.";

    private static RunStageRecord CreateStageRecord(
        RunStageName stageName,
        RunStageStatus status,
        DateTimeOffset startedAtUtc,
        DateTimeOffset? completedAtUtc,
        string details)
        => new(
            stageName,
            status,
            startedAtUtc,
            completedAtUtc,
            details);

    private static NormalizedRunRequest ApplyRuntimeInferences(
        NormalizedRunRequest request,
        RepositoryTarget? repositoryTarget,
        RepositoryContextBundle? repositoryContext)
        => request with
        {
            RepositoryAlias = repositoryTarget?.Alias ?? request.RepositoryAlias,
            TestScope = InferTestScope(request.TestScope, repositoryTarget, repositoryContext),
        };

    private static TestScope InferTestScope(
        TestScope fallback,
        RepositoryTarget? repositoryTarget,
        RepositoryContextBundle? repositoryContext)
    {
        var scopeScores = Enum.GetValues<TestScope>()
            .ToDictionary(scope => scope, _ => 0);

        var signals = new List<string>();
        if (repositoryTarget is not null)
        {
            signals.Add(repositoryTarget.Alias);
            signals.Add(repositoryTarget.RepositoryName);
            signals.Add(repositoryTarget.RepositoryUrl);
        }

        if (repositoryContext is not null)
        {
            signals.AddRange(repositoryContext.ChangedFiles.Select(change => change.Path));
            signals.AddRange(repositoryContext.NeighboringTests.Select(test => test.Path));
            signals.AddRange(repositoryContext.NeighboringTests.Select(test => test.Content));
        }

        foreach (var signal in signals.Where(value => !string.IsNullOrWhiteSpace(value)))
        {
            var normalized = Regex.Replace(signal, "\\s+", " ").Trim().ToLowerInvariant();
            foreach (var (scope, keywords, weight) in TestScopeSignals)
            {
                if (keywords.Any(keyword => normalized.Contains(keyword, StringComparison.OrdinalIgnoreCase)))
                {
                    scopeScores[scope] += weight;
                }
            }
        }

        var best = scopeScores
            .OrderByDescending(item => item.Value)
            .ThenBy(item => item.Key)
            .First();

        return best.Value > 0 ? best.Key : fallback;
    }
}
