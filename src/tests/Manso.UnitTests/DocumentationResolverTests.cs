using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging.Abstractions;

namespace Manso.UnitTests;

public sealed class DocumentationResolverTests
{
    [Fact]
    public async Task ResolveAsync_ReturnsDocuments_ForExplicitLinksOnly()
    {
        var client = new StubConfluenceApiClient();
        var resolver = new DocumentationResolver(
            client,
            new DocumentationRetrievalOptions
            {
                IncludeCommentLinks = false,
                MaxPages = 5,
                MaxChunksPerPage = 2,
                RequireDocumentation = false,
            },
            NullLogger<DocumentationResolver>.Instance);

        var result = await resolver.ResolveAsync(CreateIssue(), CreateRequest(), CancellationToken.None);

        Assert.Equal(2, result.Documents.Count);
        Assert.Empty(result.Warnings);
        Assert.All(result.Documents, document => Assert.True(document.Chunks.Count <= 2));
    }

    [Fact]
    public async Task ResolveAsync_ReturnsWarning_WhenNoExplicitLinksExist()
    {
        var resolver = new DocumentationResolver(
            new StubConfluenceApiClient(),
            new DocumentationRetrievalOptions { RequireDocumentation = false },
            NullLogger<DocumentationResolver>.Instance);

        var result = await resolver.ResolveAsync(CreateIssue(), CreateRequest(Array.Empty<string>()), CancellationToken.None);

        Assert.Empty(result.Documents);
        Assert.Contains(result.Warnings, warning => warning.Code == "no_explicit_documentation_links");
    }

    [Fact]
    public async Task ResolveAsync_UsesCommentLinks_WhenEnabled()
    {
        var resolver = new DocumentationResolver(
            new StubConfluenceApiClient(),
            new DocumentationRetrievalOptions
            {
                IncludeCommentLinks = true,
                MaxPages = 5,
                MaxChunksPerPage = 3,
            },
            NullLogger<DocumentationResolver>.Instance);

        var result = await resolver.ResolveAsync(CreateIssue(), CreateRequest(Array.Empty<string>()), CancellationToken.None);

        Assert.Single(result.Documents);
        Assert.Equal("22222", result.Documents[0].PageId);
    }

    private static JiraIssueContext CreateIssue()
        => new(
            "QA-1234",
            "Retry callback",
            "Issue description",
            null,
            "Story",
            "High",
            [new JiraCommentContext(
                "1",
                "Alice",
                "See https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/22222/Retry+Decision+Log",
                DateTimeOffset.UtcNow)],
            Array.Empty<string>(),
            Array.Empty<string>(),
            Array.Empty<JiraDevelopmentRepository>());

    private static NormalizedRunRequest CreateRequest(IReadOnlyList<string>? links = null)
        => new(
            "QA-1234",
            "https://yourcompany.atlassian.net/browse/QA-1234",
            GenerationMode.TestCasesOnly,
            WorkflowPass.ScenarioDesign,
            TestScope.Api,
            "bank-otp-api",
            null,
            links ?? new[]
            {
                "https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+Flow",
                "https://yourcompany.atlassian.net/wiki/spaces/API/pages/67890/Callback+Contract",
            },
            CoverageIntent.Regression,
            OutputTarget.JiraComment,
            new RequestedBy("abc", "Manuel", "manuel@example.com"),
            DocumentationMode.ExplicitOnly);

    private sealed class StubConfluenceApiClient : IConfluenceApiClient
    {
        public Task<ConfluenceDocument> GetDocumentAsync(
            string sourceUrl,
            string pageId,
            int maxChunks,
            CancellationToken ct)
        {
            var allChunks = new[]
            {
                new ConfluenceChunk($"{pageId}-1", "Overview", "Overview text", 5),
                new ConfluenceChunk($"{pageId}-2", "Details", "Details text", 5),
                new ConfluenceChunk($"{pageId}-3", "Examples", "Examples text", 5),
            };

            return Task.FromResult(new ConfluenceDocument(
                sourceUrl,
                pageId,
                $"Page {pageId}",
                "ENG",
                1,
                DateTimeOffset.UtcNow,
                allChunks.Take(maxChunks).ToArray()));
        }
    }
}
