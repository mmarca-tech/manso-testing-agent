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
            extraDocumentationLinks: """
                https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+Flow
                https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+Flow
                https://yourcompany.atlassian.net/wiki/spaces/QA/pages/11111/Test+Strategy
                https://yourcompany.atlassian.net/wiki/spaces/API/pages/67890/Callback+Contract
                """);

        var result = await normalizer.NormalizeAsync(request, CancellationToken.None);

        Assert.Equal(WorkflowPass.ScenarioDesign, result.Request.WorkflowPass);
        Assert.Null(result.Request.RepositoryAlias);
        Assert.Equal(
            [
                "https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+Flow",
                "https://yourcompany.atlassian.net/wiki/spaces/QA/pages/11111/Test+Strategy",
                "https://yourcompany.atlassian.net/wiki/spaces/API/pages/67890/Callback+Contract",
            ],
            result.Request.ExplicitDocumentationLinks);
        Assert.Equal(DocumentationMode.ExplicitOnly, result.Request.DocumentationMode);
        Assert.Empty(result.Warnings);
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
            extraDocumentationLinks: "https://example.com/specs/123\nhttp://yourcompany.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+Flow");

        var result = await normalizer.NormalizeAsync(request, CancellationToken.None);

        Assert.Empty(result.Request.ExplicitDocumentationLinks);
        Assert.Equal(DocumentationMode.ExplicitOnlyNoDocs, result.Request.DocumentationMode);
        Assert.Equal(2, result.Warnings.Count);
    }

    [Fact]
    public async Task NormalizeAsync_CarriesDryRunFlag()
    {
        var normalizer = new RequestNormalizer(new RequestNormalizationOptions());
        var request = CreateRequest(dryRun: true);

        var result = await normalizer.NormalizeAsync(request, CancellationToken.None);

        Assert.True(result.Request.DryRun);
    }

    private static RawRunRequest CreateRequest(
        string? generationMode = "ExecutableTests",
        string? workflowPass = "ScenarioDesign",
        string? extraDocumentationLinks = null,
        bool dryRun = false)
        => new(
            "JiraAutomation",
            "Manual",
            new RawIssuePayload(
                "QA-1234",
                "10001"),
            new RawTriggerInputs(
                generationMode,
                workflowPass,
                extraDocumentationLinks,
                "Regression",
                "Both",
                dryRun),
            new RawRequester(
                "abc-123",
                "Manuel Marcatili",
                "manuel@example.com"));
}
