using Manso.Api;
using Manso.Application;
using Manso.Domain;
using Manso.Infrastructure;
using System.Text.Json.Serialization;

var builder = WebApplication.CreateBuilder(args);

builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(options => options.IncludeScopes = true);
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
});

builder.Services.AddHealthChecks();
builder.Services.Configure<RunIntakeAuthenticationOptions>(
    builder.Configuration.GetSection(RunIntakeAuthenticationOptions.SectionName));
builder.Services.Configure<JiraOptions>(
    builder.Configuration.GetSection(JiraOptions.SectionName));
builder.Services.Configure<ConfluenceOptions>(
    builder.Configuration.GetSection(ConfluenceOptions.SectionName));
builder.Services.Configure<ScmOptions>(
    builder.Configuration.GetSection(ScmOptions.SectionName));
builder.Services.Configure<XrayOptions>(
    builder.Configuration.GetSection(XrayOptions.SectionName));
builder.Services.Configure<RepoAdapterOptions>(
    builder.Configuration.GetSection(RepoAdapterOptions.SectionName));
builder.Services.Configure<LlmGatewayOptions>(
    builder.Configuration.GetSection(LlmGatewayOptions.SectionName));

var normalizationOptions =
    builder.Configuration.GetSection(RequestNormalizationOptions.SectionName).Get<RequestNormalizationOptions>()
    ?? new RequestNormalizationOptions();
var jiraRetrievalOptions =
    builder.Configuration.GetSection(JiraRetrievalOptions.SectionName).Get<JiraRetrievalOptions>()
    ?? new JiraRetrievalOptions();
var documentationRetrievalOptions =
    builder.Configuration.GetSection(DocumentationRetrievalOptions.SectionName).Get<DocumentationRetrievalOptions>()
    ?? new DocumentationRetrievalOptions();
var xrayRetrievalOptions =
    builder.Configuration.GetSection(XrayRetrievalOptions.SectionName).Get<XrayRetrievalOptions>()
    ?? new XrayRetrievalOptions();
var repositoryRetrievalOptions =
    builder.Configuration.GetSection(RepositoryRetrievalOptions.SectionName).Get<RepositoryRetrievalOptions>()
    ?? new RepositoryRetrievalOptions();
var generationContextOptions =
    builder.Configuration.GetSection(GenerationContextOptions.SectionName).Get<GenerationContextOptions>()
    ?? new GenerationContextOptions();
var scenarioGenerationOptions =
    builder.Configuration.GetSection(ScenarioGenerationOptions.SectionName).Get<ScenarioGenerationOptions>()
    ?? new ScenarioGenerationOptions();
var validationOptions =
    builder.Configuration.GetSection(ValidationOptions.SectionName).Get<ValidationOptions>()
    ?? new ValidationOptions();

builder.Services.AddSingleton(normalizationOptions);
builder.Services.AddSingleton(jiraRetrievalOptions);
builder.Services.AddSingleton(documentationRetrievalOptions);
builder.Services.AddSingleton(xrayRetrievalOptions);
builder.Services.AddSingleton(repositoryRetrievalOptions);
builder.Services.AddSingleton(generationContextOptions);
builder.Services.AddSingleton(scenarioGenerationOptions);
builder.Services.AddSingleton(validationOptions);
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddRunPersistence(builder.Configuration);
builder.Services.AddHttpClient("JiraApi", (serviceProvider, client) =>
{
    var options = serviceProvider.GetRequiredService<Microsoft.Extensions.Options.IOptions<JiraOptions>>().Value;
    if (Uri.TryCreate(options.BaseUrl, UriKind.Absolute, out var baseUri))
    {
        client.BaseAddress = baseUri;
    }
});
builder.Services.AddHttpClient("ConfluenceApi", (serviceProvider, client) =>
{
    var options = serviceProvider.GetRequiredService<Microsoft.Extensions.Options.IOptions<ConfluenceOptions>>().Value;
    if (Uri.TryCreate(options.BaseUrl, UriKind.Absolute, out var baseUri))
    {
        client.BaseAddress = baseUri;
    }
});
builder.Services.AddHttpClient("ScmApi", (serviceProvider, client) =>
{
    var options = serviceProvider.GetRequiredService<Microsoft.Extensions.Options.IOptions<ScmOptions>>().Value;
    if (Uri.TryCreate(options.BaseUrl, UriKind.Absolute, out var baseUri))
    {
        client.BaseAddress = baseUri;
    }
});
builder.Services.AddHttpClient("XrayApi", (serviceProvider, client) =>
{
    var options = serviceProvider.GetRequiredService<Microsoft.Extensions.Options.IOptions<XrayOptions>>().Value;
    if (Uri.TryCreate(options.BaseUrl, UriKind.Absolute, out var baseUri))
    {
        client.BaseAddress = baseUri;
    }
});
builder.Services.AddHttpClient("LlmApi", (serviceProvider, client) =>
{
    var options = serviceProvider.GetRequiredService<Microsoft.Extensions.Options.IOptions<LlmGatewayOptions>>().Value;
    if (Uri.TryCreate(options.BaseUrl, UriKind.Absolute, out var baseUri))
    {
        client.BaseAddress = baseUri;
    }
});
builder.Services.AddSingleton<IRunIdFactory, UtcTimestampRunIdFactory>();
builder.Services.AddSingleton<IBackgroundRunQueue, ChannelBackgroundRunQueue>();
builder.Services.AddSingleton<IRequestNormalizer, RequestNormalizer>();
builder.Services.AddSingleton<AtlassianDocumentTextExtractor>();
builder.Services.AddSingleton<IJiraApiClient, JiraApiClient>();
builder.Services.AddSingleton<IConfluenceApiClient, ConfluenceApiClient>();
builder.Services.AddSingleton<IXrayApiClient, XrayCloudApiClient>();
builder.Services.AddSingleton<IScmClient, AzureDevOpsScmClient>();
builder.Services.AddSingleton<ILlmGateway>(serviceProvider =>
{
    var options = serviceProvider.GetRequiredService<Microsoft.Extensions.Options.IOptions<LlmGatewayOptions>>().Value;
    return options.Provider switch
    {
        LlmProvider.Mock => ActivatorUtilities.CreateInstance<MockLlmGateway>(serviceProvider),
        LlmProvider.OpenAi => ActivatorUtilities.CreateInstance<OpenAiLlmGateway>(serviceProvider),
        LlmProvider.Anthropic => ActivatorUtilities.CreateInstance<AnthropicLlmGateway>(serviceProvider),
        _ => ActivatorUtilities.CreateInstance<DisabledLlmGateway>(serviceProvider),
    };
});
builder.Services.AddSingleton<IJiraContextService, JiraContextService>();
builder.Services.AddSingleton<IDocumentationResolver, DocumentationResolver>();
builder.Services.AddSingleton<IRepositoryResolver, RepositoryResolver>();
builder.Services.AddSingleton<IRepositoryAdapterCatalog, RepositoryAdapterCatalog>();
builder.Services.AddSingleton<IRepositoryContextService, RepositoryContextService>();
builder.Services.AddSingleton<IXrayContextService, XrayContextService>();
builder.Services.AddSingleton<IXrayTestCaseSyncService, XrayTestCaseSyncService>();
builder.Services.AddSingleton<IGenerationContextBundleBuilder, GenerationContextBundleBuilder>();
builder.Services.AddSingleton<IScenarioGenerator, ScenarioGenerator>();
builder.Services.AddSingleton<IOutputValidator, OutputValidator>();
builder.Services.AddSingleton<IOutputWriter, OutputWriter>();
builder.Services.AddSingleton<ITestGenerationRunService, TestGenerationRunService>();
builder.Services.AddHostedService<RunExecutionBackgroundService>();

var app = builder.Build();

await app.Services.GetRequiredService<RunStoreSchemaInitializer>()
    .InitializeAsync(app.Lifetime.ApplicationStopping);

app.UseMiddleware<CorrelationIdMiddleware>();
app.UseMiddleware<ExceptionHandlingMiddleware>();
app.UseMiddleware<BearerTokenAuthenticationMiddleware>();

app.MapHealthChecks("/health/live");
app.MapHealthChecks("/health/ready");

app.MapPost("/api/runs", async (
    RawRunRequest request,
    HttpContext httpContext,
    ITestGenerationRunService runService,
    CancellationToken ct) =>
{
    var response = await runService.StartAsync(request, httpContext.GetCorrelationId(), ct);
    return Results.Accepted($"/api/runs/{response.RunId}", response);
});

app.MapGet("/api/runs/{runId}", async (
    string runId,
    ITestGenerationRunService runService,
    CancellationToken ct) =>
{
    var run = await runService.GetAsync(runId, ct);
    return run is null
        ? Results.NotFound(new ApiErrorResponse("RUN_NOT_FOUND", $"Run '{runId}' was not found."))
        : Results.Ok(RunResponseMapper.Map(run));
});

app.MapGet("/api/runs/{runId}/artifacts", async (
    string runId,
    ITestGenerationRunService runService,
    CancellationToken ct) =>
{
    var run = await runService.GetAsync(runId, ct);
    return run is null
        ? Results.NotFound(new ApiErrorResponse("RUN_NOT_FOUND", $"Run '{runId}' was not found."))
        : Results.Ok(RunResponseMapper.MapArtifacts(run));
});

app.MapGet("/api/runs/{runId}/artifacts/{artifactName}", async (
    string runId,
    string artifactName,
    ITestGenerationRunService runService,
    CancellationToken ct) =>
{
    var run = await runService.GetAsync(runId, ct);
    if (run is null)
    {
        return Results.NotFound(new ApiErrorResponse("RUN_NOT_FOUND", $"Run '{runId}' was not found."));
    }

    var artifact = run.FindStoredArtifact(artifactName);
    return artifact is null
        ? Results.NotFound(new ApiErrorResponse("ARTIFACT_NOT_FOUND", $"Artifact '{artifactName}' was not found for run '{runId}'."))
        : Results.Content(artifact.Content, artifact.ContentType);
});

app.Run();

public partial class Program
{
}
