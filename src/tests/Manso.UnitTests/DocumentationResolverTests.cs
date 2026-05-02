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
            CreateLinkNormalizer(),
            NullLogger<DocumentationResolver>.Instance);

        var issue = CreateIssue() with
        {
            Description = """
                See https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+Flow
                and https://yourcompany.atlassian.net/wiki/spaces/API/pages/67890/Callback+Contract
                """,
        };

        var result = await resolver.ResolveAsync(issue, CancellationToken.None);

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
            CreateLinkNormalizer(),
            NullLogger<DocumentationResolver>.Instance);

        var result = await resolver.ResolveAsync(CreateIssue(), CancellationToken.None);

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
            CreateLinkNormalizer(),
            NullLogger<DocumentationResolver>.Instance);

        var result = await resolver.ResolveAsync(CreateIssue(), CancellationToken.None);

        Assert.Single(result.Documents);
        Assert.Equal("22222", result.Documents[0].PageId);
    }

    [Fact]
    public async Task ResolveAsync_UsesIssueDescriptionLinks_FromFetchedJiraContext()
    {
        var resolver = new DocumentationResolver(
            new StubConfluenceApiClient(),
            new DocumentationRetrievalOptions
            {
                IncludeCommentLinks = false,
                MaxPages = 1,
                MaxChunksPerPage = 3,
            },
            CreateLinkNormalizer(),
            NullLogger<DocumentationResolver>.Instance);

        var issue = CreateIssue() with
        {
            Description = "See https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/33333/Retry+Rules",
            Comments = Array.Empty<JiraCommentContext>(),
        };

        var result = await resolver.ResolveAsync(issue, CancellationToken.None);

        Assert.Single(result.Documents);
        Assert.Equal("33333", result.Documents[0].PageId);
    }

    [Fact]
    public async Task ResolveAsync_ValidatesIssueDescriptionLinksAgainstAllowedHosts()
    {
        var resolver = new DocumentationResolver(
            new StubConfluenceApiClient(),
            new DocumentationRetrievalOptions
            {
                IncludeCommentLinks = false,
                MaxPages = 5,
                MaxChunksPerPage = 3,
            },
            CreateLinkNormalizer(),
            NullLogger<DocumentationResolver>.Instance);
        var issue = CreateIssue() with
        {
            Description = """
                See https://evil.example/wiki/spaces/ENG/pages/11111/Bad+Host
                and http://yourcompany.atlassian.net/wiki/spaces/ENG/pages/22222/Insecure
                and https://yourcompany.atlassian.net/browse/QA-1234
                and https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/33333/Retry+Rules
                """,
            AcceptanceCriteria = null,
            Comments = Array.Empty<JiraCommentContext>(),
        };

        var result = await resolver.ResolveAsync(issue, CancellationToken.None);

        Assert.Single(result.Documents);
        Assert.Equal("33333", result.Documents[0].PageId);
        Assert.Equal(3, result.Warnings.Count(warning => warning.Code == "documentation_link_ignored"));
    }

    [Fact]
    public async Task ResolveAsync_ValidatesCommentLinksAgainstAllowedHosts_WhenEnabled()
    {
        var resolver = new DocumentationResolver(
            new StubConfluenceApiClient(),
            new DocumentationRetrievalOptions
            {
                IncludeCommentLinks = true,
                MaxPages = 5,
                MaxChunksPerPage = 3,
            },
            CreateLinkNormalizer(),
            NullLogger<DocumentationResolver>.Instance);
        var issue = CreateIssue() with
        {
            Description = string.Empty,
            AcceptanceCriteria = null,
            Comments =
            [
                new JiraCommentContext(
                    "1",
                    "Alice",
                    """
                    Invalid https://othercompany.atlassian.net/wiki/spaces/ENG/pages/11111/Other+Tenant
                    Valid https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/22222/Retry+Decision+Log
                    """,
                    DateTimeOffset.UtcNow),
            ],
        };

        var result = await resolver.ResolveAsync(issue, CancellationToken.None);

        Assert.Single(result.Documents);
        Assert.Equal("22222", result.Documents[0].PageId);
        Assert.Contains(
            result.Warnings,
            warning => warning.Code == "documentation_link_ignored" &&
                       warning.Message.Contains("othercompany.atlassian.net", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task ResolveAsync_ExcludesReleaseDocumentation()
    {
        var resolver = new DocumentationResolver(
            new StubConfluenceApiClient(),
            new DocumentationRetrievalOptions
            {
                MaxPages = 5,
                MaxChunksPerPage = 3,
            },
            CreateLinkNormalizer(),
            NullLogger<DocumentationResolver>.Instance);

        var result = await resolver.ResolveAsync(
            CreateIssue() with
            {
                Description = """
                    See https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+Flow
                    and https://yourcompany.atlassian.net/wiki/spaces/REL/pages/99999/Release+Notes
                    """,
            },
            CancellationToken.None);

        Assert.Single(result.Documents);
        Assert.DoesNotContain(result.Documents, document => document.PageId == "99999");
        Assert.Contains(result.Warnings, warning => warning.Code == "documentation_link_excluded_release_information");
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
            Array.Empty<JiraLinkedIssue>(),
            Array.Empty<string>(),
            Array.Empty<string>(),
            Array.Empty<JiraDevelopmentRepository>());

    private static DocumentationLinkNormalizer CreateLinkNormalizer()
        => new(new ConfluenceLinkOptions
        {
            AllowedHosts = ["yourcompany.atlassian.net"],
        });

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
                pageId == "99999" ? "Release Notes" : $"Page {pageId}",
                "ENG",
                1,
                DateTimeOffset.UtcNow,
                allChunks.Take(maxChunks).ToArray()));
        }
    }
}
