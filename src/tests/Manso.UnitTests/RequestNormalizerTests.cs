using Manso.Application;
using Manso.Domain;

namespace Manso.UnitTests;

public sealed class RequestNormalizerTests
{
    [Fact]
    public async Task NormalizeAsync_UsesManualOverrideAndDeduplicatesDocumentationLinks()
    {
        var normalizer = new RequestNormalizer(new RequestNormalizationOptions
        {
            AllowedConfluenceHosts = ["yourcompany.atlassian.net"],
            DefaultTestScope = TestScope.Api,
        });

        var request = CreateRequest(
            description: """
                Story details
                https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+Flow
                """,
            repositoryOverride: "payments-api-manual",
            configuredRepository: "payments-api-configured",
            extraDocumentationLinks: """
                https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+Flow
                https://yourcompany.atlassian.net/wiki/spaces/API/pages/67890/Callback+Contract
                """,
            documentationLinks: """
                https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+Flow
                https://yourcompany.atlassian.net/wiki/spaces/QA/pages/11111/Test+Strategy
                """);

        var result = await normalizer.NormalizeAsync(request, CancellationToken.None);

        Assert.Equal(WorkflowPass.ScenarioDesign, result.Request.WorkflowPass);
        Assert.Equal("payments-api-manual", result.Request.RepositoryAlias);
        Assert.Null(result.Request.BranchOrPrHint);
        Assert.Equal(
            [
                "https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+Flow",
                "https://yourcompany.atlassian.net/wiki/spaces/QA/pages/11111/Test+Strategy",
                "https://yourcompany.atlassian.net/wiki/spaces/API/pages/67890/Callback+Contract",
            ],
            result.Request.ExplicitDocumentationLinks);
        Assert.Equal(DocumentationMode.ExplicitOnly, result.Request.DocumentationMode);
        Assert.Contains(result.Warnings, warning => warning.Code == "branch_or_pr_override_ignored");
    }

    [Fact]
    public async Task NormalizeAsync_ThrowsForInvalidGenerationMode()
    {
        var normalizer = new RequestNormalizer(new RequestNormalizationOptions());
        var request = CreateRequest(generationMode: "GenerateEverything");

        var exception = await Assert.ThrowsAsync<RequestValidationException>(
            () => normalizer.NormalizeAsync(request, CancellationToken.None));

        Assert.Equal("triggerInputs.generationMode", exception.Field);
        Assert.Equal("GenerateEverything", exception.Value);
    }

    [Fact]
    public async Task NormalizeAsync_ThrowsForInvalidWorkflowPass()
    {
        var normalizer = new RequestNormalizer(new RequestNormalizationOptions());
        var request = CreateRequest(workflowPass: "DoEverything");

        var exception = await Assert.ThrowsAsync<RequestValidationException>(
            () => normalizer.NormalizeAsync(request, CancellationToken.None));

        Assert.Equal("triggerInputs.workflowPass", exception.Field);
        Assert.Equal("DoEverything", exception.Value);
    }

    [Fact]
    public async Task NormalizeAsync_WarnsForInvalidDocumentationLinksAndKeepsExplicitOnlyNoDocs()
    {
        var normalizer = new RequestNormalizer(new RequestNormalizationOptions
        {
            AllowedConfluenceHosts = ["yourcompany.atlassian.net"],
        });

        var request = CreateRequest(
            description: "See https://example.com/specs/123 and http://yourcompany.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+Flow",
            branchOrPrOverride: null);

        var result = await normalizer.NormalizeAsync(request, CancellationToken.None);

        Assert.Empty(result.Request.ExplicitDocumentationLinks);
        Assert.Equal(DocumentationMode.ExplicitOnlyNoDocs, result.Request.DocumentationMode);
        Assert.Equal(2, result.Warnings.Count);
    }

    private static RawRunRequest CreateRequest(
        string description = "Issue description",
        string? generationMode = "ExecutableTests",
        string? workflowPass = "ScenarioDesign",
        string? repositoryOverride = null,
        string? branchOrPrOverride = " feature/QA-1234 ",
        string? configuredRepository = null,
        string? extraDocumentationLinks = null,
        string? documentationLinks = null)
        => new(
            "JiraAutomation",
            "Manual",
            new RawIssuePayload(
                "QA-1234",
                "10001",
                "QA",
                "Story",
                "Add retry handling",
                description,
                "https://yourcompany.atlassian.net/browse/QA-1234"),
            new RawTriggerInputs(
                generationMode,
                workflowPass,
                "Api",
                repositoryOverride,
                branchOrPrOverride,
                extraDocumentationLinks,
                "Regression",
                "Both"),
            new RawIssueFields(
                configuredRepository,
                documentationLinks),
            new RawRequester(
                "abc-123",
                "Manuel Marcatili",
                "manuel@example.com"));
}
