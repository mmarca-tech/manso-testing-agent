using Manso.Domain;

namespace Manso.Application;

public interface IJiraContextService
{
    Task<JiraIssueContext> BuildAsync(NormalizedRunRequest request, CancellationToken ct);
}

public interface IDocumentationResolver
{
    Task<DocumentationResolutionResult> ResolveAsync(
        JiraIssueContext issue,
        CancellationToken ct);
}

public interface IRepositoryResolver
{
    Task<RepositoryTarget> ResolveAsync(
        JiraIssueContext issue,
        NormalizedRunRequest request,
        CancellationToken ct);
}

public interface IRepositoryContextService
{
    Task<RepositoryContextBundle> BuildAsync(
        RepositoryTarget target,
        NormalizedRunRequest request,
        CancellationToken ct);
}

public interface IRepositoryAdapter
{
    string Alias { get; }

    bool SupportsExecutableTestGeneration { get; }

    Task<RepositoryConventions> GetConventionsAsync(
        RepositoryTarget target,
        IReadOnlyList<RepositoryGuidanceFile> guidanceFiles,
        CancellationToken ct);
}

public interface IRepositoryAdapterCatalog
{
    IRepositoryAdapter GetRequired(string alias);
}

public interface IGenerationContextBundleBuilder
{
    Task<GenerationContextBundle> BuildAsync(
        NormalizedRunRequest request,
        JiraIssueContext jira,
        IReadOnlyList<ConfluenceDocument> documents,
        RepositoryTarget? repositoryTarget,
        RepositoryContextBundle? repositoryContext,
        XrayContextBundle xrayContext,
        CancellationToken ct);
}

public interface IRuntimePromptSectionProvider
{
    GenerationContextSection BuildScenarioGenerationSection(
        TestScope testScope,
        WorkflowPass workflowPass);
}

public interface IXrayContextService
{
    Task<XrayContextBundle> BuildAsync(
        NormalizedRunRequest request,
        JiraIssueContext issue,
        RepositoryTarget? repositoryTarget,
        RepositoryContextBundle? repositoryContext,
        CancellationToken ct);
}

public interface IXrayTestCaseSyncService
{
    Task<XrayScenarioSyncResult> SyncAsync(
        NormalizedRunRequest request,
        JiraIssueContext issue,
        GeneratedScenarioBundle scenarios,
        RepositoryContextBundle? repositoryContext,
        XrayContextBundle xrayContext,
        CancellationToken ct);
}

public interface IScenarioGenerator
{
    LlmPromptRequest PreviewPrompt(GenerationContextBundle bundle);

    Task<GeneratedScenarioBundle> GenerateAsync(
        GenerationContextBundle bundle,
        CancellationToken ct);
}

public interface IOutputValidator
{
    Task<ValidationResult> ValidateAsync(
        GenerationContextBundle bundle,
        GeneratedScenarioBundle scenarios,
        CancellationToken ct);
}

public interface IOutputWriter
{
    Task<OutputWriteResult> WriteAsync(
        GenerationContextBundle bundle,
        GeneratedScenarioBundle scenarios,
        ValidationResult validation,
        CancellationToken ct);
}

public interface ILlmGateway
{
    Task<LlmCompletionResult> CompleteJsonAsync(
        LlmPromptRequest request,
        CancellationToken ct);
}

public interface IScmClient
{
    Task<RepositoryPullRequest> GetPullRequestAsync(
        RepositoryTarget repository,
        int pullRequestId,
        CancellationToken ct);

    Task<RepositoryContextBundle> GetCodeContextAsync(
        RepositoryTarget target,
        RepositoryRetrievalOptions options,
        RepositoryConventions conventions,
        CancellationToken ct);

    Task<IReadOnlyList<RepositoryGuidanceFile>> GetRepositoryFilesAsync(
        RepositoryTarget target,
        IReadOnlyList<string> paths,
        CancellationToken ct);
}

public interface IJiraApiClient
{
    Task<JiraIssueContext> GetIssueContextAsync(
        string issueKey,
        bool includeComments,
        int maxComments,
        CancellationToken ct);

    Task EnsureTestCoverageLinkAsync(
        string requirementIssueKey,
        string testIssueKey,
        CancellationToken ct);
}

public interface IConfluenceApiClient
{
    Task<ConfluenceDocument> GetDocumentAsync(
        string sourceUrl,
        string pageId,
        int maxChunks,
        CancellationToken ct);
}

public interface IXrayApiClient
{
    Task<IReadOnlyList<XrayTestCase>> SearchTestsAsync(
        XrayTestSearchRequest request,
        CancellationToken ct);

    Task<IReadOnlyList<XrayTestSet>> SearchTestSetsAsync(
        XrayTestSetSearchRequest request,
        CancellationToken ct);

    Task<XrayTestCaseUpsertResult> UpsertTestCaseAsync(
        XrayTestCaseUpsertRequest request,
        CancellationToken ct);

    Task<XrayTestSetCreateResult> CreateTestSetAsync(
        XrayTestSetCreateRequest request,
        CancellationToken ct);

    Task AddTestsToTestSetAsync(
        XrayAssociationUpdateRequest request,
        CancellationToken ct);
}

public sealed record DocumentationResolutionResult(
    IReadOnlyList<ConfluenceDocument> Documents,
    IReadOnlyList<RunWarning> Warnings)
{
    public int ProviderRequestCount { get; init; }
}

public sealed class JiraRetrievalOptions
{
    public const string SectionName = "JiraRetrieval";

    public bool IncludeComments { get; init; } = true;

    public int MaxComments { get; init; } = 10;
}

public sealed class DocumentationRetrievalOptions
{
    public const string SectionName = "DocumentationRetrieval";

    public bool IncludeCommentLinks { get; init; }

    public int MaxPages { get; init; } = 5;

    public int MaxChunksPerPage { get; init; } = 3;

    public bool RequireDocumentation { get; init; }
}

public sealed class ConfluenceLinkOptions
{
    public const string SectionName = "Confluence";

    public string[] AllowedHosts { get; init; } = Array.Empty<string>();
}

public sealed class XrayRetrievalOptions
{
    public const string SectionName = "XrayRetrieval";

    public bool Enabled { get; init; }

    public int MaxNeighboringTests { get; init; } = 5;

    public bool EnableScenarioAutoUpsert { get; init; }

    public string DefaultCreatedTestType { get; init; } = "Cucumber";
}

public sealed class RepositoryRetrievalOptions
{
    public const string SectionName = "RepositoryRetrieval";

    public int MaxChangedFiles { get; init; } = 25;

    public int MaxDiffLinesPerFile { get; init; } = 80;

    public int MaxNeighboringTests { get; init; } = 5;

    public int MaxNeighboringTestLines { get; init; } = 120;
}

public sealed class GenerationContextOptions
{
    public const string SectionName = "GenerationContext";

    public int MaxChangedFileExcerpts { get; init; } = 8;

    public int MaxNeighboringTests { get; init; } = 5;

    public int MaxComments { get; init; } = 5;
}

public sealed class ScenarioGenerationOptions
{
    public const string SectionName = "ScenarioGeneration";

    public int MinScenarios { get; init; } = 1;

    public int MaxScenarios { get; init; } = 8;
}

public sealed class RuntimePromptOptions
{
    public const string SectionName = "RuntimePrompt";
    public const string DefaultRootPath = "agent-runtime";

    public string RootPath { get; init; } = DefaultRootPath;
}

public sealed class LlmGatewayOptions
{
    public const string SectionName = "Llm";

    public LlmProvider Provider { get; init; } = LlmProvider.Disabled;

    public string ApiKey { get; init; } = string.Empty;

    public string Model { get; init; } = string.Empty;

    public string BaseUrl { get; init; } = string.Empty;

    public int MaxOutputTokens { get; init; } = 4000;

    public int RequestTimeoutSeconds { get; init; } = 300;

    public decimal Temperature { get; init; } = 0.2m;
}

public enum LlmProvider
{
    Disabled,
    Mock,
    OpenAi,
    Anthropic,
}

public sealed record LlmPromptRequest(
    string SystemPrompt,
    string UserPrompt,
    string? JsonSchema);

public sealed record LlmCompletionResult(
    string Provider,
    string Model,
    string JsonOutput)
{
    public LlmUsageMetrics? Usage { get; init; }

    public int ProviderRequestCount { get; init; }
}

public sealed class RepositoryContextUnavailableException : Exception
{
    public RepositoryContextUnavailableException(string message)
        : base(message)
    {
    }
}
