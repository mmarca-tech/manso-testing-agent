using Manso.Domain;
using Microsoft.Extensions.Logging;
using System.Text.RegularExpressions;

namespace Manso.Application;

public sealed class DocumentationResolver : IDocumentationResolver
{
    private static readonly Regex UrlRegex = new(@"https?://[^\s<>()]+", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly string[] ReleaseDocumentationMarkers =
    [
        "release documentation",
        "release doc",
        "release notes",
        "release note",
        "release plan",
    ];

    private readonly IConfluenceApiClient _confluenceApiClient;
    private readonly DocumentationRetrievalOptions _options;
    private readonly DocumentationLinkNormalizer _documentationLinkNormalizer;
    private readonly ILogger<DocumentationResolver> _logger;

    public DocumentationResolver(
        IConfluenceApiClient confluenceApiClient,
        DocumentationRetrievalOptions options,
        DocumentationLinkNormalizer documentationLinkNormalizer,
        ILogger<DocumentationResolver> logger)
    {
        _confluenceApiClient = confluenceApiClient;
        _options = options;
        _documentationLinkNormalizer = documentationLinkNormalizer;
        _logger = logger;
    }

    public async Task<DocumentationResolutionResult> ResolveAsync(
        JiraIssueContext issue,
        CancellationToken ct)
    {
        var warnings = new List<RunWarning>();
        var explicitLinks = new List<string>();
        var providerRequestCount = 0;
        explicitLinks.AddRange(ExtractUrls(issue.Description));
        explicitLinks.AddRange(ExtractUrls(issue.AcceptanceCriteria));

        if (_options.IncludeCommentLinks)
        {
            explicitLinks.AddRange(
                issue.Comments.SelectMany(comment => ExtractUrls(comment.Body)));
        }

        var orderedLinks = explicitLinks
            .Select(link => NormalizeDocumentationLink(link, warnings))
            .Where(link => !string.IsNullOrWhiteSpace(link))
            .Select(link => link!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(_options.MaxPages)
            .ToArray();

        if (orderedLinks.Length == 0)
        {
            warnings.Add(new RunWarning(
                "no_explicit_documentation_links",
                "No valid explicit Confluence links were found in the Jira issue context; continuing without documentation."));

            if (_options.RequireDocumentation)
            {
                throw new InvalidOperationException("Documentation is required for this run but no explicit Confluence links were found in the Jira issue context.");
            }

            return new DocumentationResolutionResult(Array.Empty<ConfluenceDocument>(), warnings)
            {
                ProviderRequestCount = providerRequestCount,
            };
        }

        var documents = new List<ConfluenceDocument>();
        foreach (var link in orderedLinks)
        {
            ct.ThrowIfCancellationRequested();

            if (!TryParsePageId(link, out var pageId))
            {
                warnings.Add(new RunWarning(
                    "documentation_link_invalid",
                    $"Ignored Confluence link because the page identifier could not be resolved: {link}"));
                continue;
            }

            try
            {
                providerRequestCount++;
                var document = await _confluenceApiClient.GetDocumentAsync(
                    link,
                    pageId,
                    _options.MaxChunksPerPage,
                    ct);

                if (IsReleaseDocumentation(document))
                {
                    warnings.Add(new RunWarning(
                        "documentation_link_excluded_release_information",
                        $"Excluded Confluence page because it appears to be release documentation rather than product behavior: {link}"));
                    continue;
                }

                documents.Add(document);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Unable to resolve Confluence page from {Link}.", link);
                warnings.Add(new RunWarning(
                    "documentation_link_unreadable",
                    $"Confluence page could not be read and was ignored: {link}"));
            }
        }

        if (documents.Count == 0)
        {
            warnings.Add(new RunWarning(
                "no_readable_confluence_documents",
                "Explicit Confluence links were found in the Jira issue context but none could be read; continuing without documentation."));

            if (_options.RequireDocumentation)
            {
                throw new InvalidOperationException("Documentation is required for this run but no Confluence page could be read.");
            }
        }

        _logger.LogInformation(
            "Resolved {DocumentCount} explicit Confluence documents from Jira issue context with {WarningCount} warnings.",
            documents.Count,
            warnings.Count);

        return new DocumentationResolutionResult(documents, warnings)
        {
            ProviderRequestCount = providerRequestCount,
        };
    }

    private static IEnumerable<string> ExtractUrls(string? input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return Array.Empty<string>();
        }

        return UrlRegex.Matches(input).Select(match => match.Value);
    }

    private string? NormalizeDocumentationLink(string link, List<RunWarning> warnings)
    {
        if (_documentationLinkNormalizer.TryNormalize(link, out var normalizedUrl, out var warning))
        {
            return normalizedUrl;
        }

        warnings.Add(warning!);
        return null;
    }

    private static bool TryParsePageId(string sourceUrl, out string pageId)
    {
        pageId = string.Empty;

        if (!Uri.TryCreate(sourceUrl, UriKind.Absolute, out var uri))
        {
            return false;
        }

        var queryPageId = GetQueryParameter(uri.Query, "pageId");
        if (!string.IsNullOrWhiteSpace(queryPageId))
        {
            pageId = queryPageId;
            return true;
        }

        var segments = uri.AbsolutePath
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        var pagesIndex = Array.FindIndex(segments, segment => segment.Equals("pages", StringComparison.OrdinalIgnoreCase));
        if (pagesIndex >= 0 && pagesIndex + 1 < segments.Length && long.TryParse(segments[pagesIndex + 1], out _))
        {
            pageId = segments[pagesIndex + 1];
            return true;
        }

        return false;
    }

    private static string? GetQueryParameter(string query, string key)
    {
        if (string.IsNullOrWhiteSpace(query))
        {
            return null;
        }

        var trimmed = query.TrimStart('?');
        foreach (var pair in trimmed.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            if (parts.Length == 2 && parts[0].Equals(key, StringComparison.OrdinalIgnoreCase))
            {
                return Uri.UnescapeDataString(parts[1]);
            }
        }

        return null;
    }

    private static bool IsReleaseDocumentation(ConfluenceDocument document)
    {
        var combined = $"{document.Title} {Uri.UnescapeDataString(document.SourceUrl)}";
        return ReleaseDocumentationMarkers.Any(marker =>
            combined.Contains(marker, StringComparison.OrdinalIgnoreCase));
    }
}
