using Manso.Domain;
using Microsoft.Extensions.Logging;
using System.Text.RegularExpressions;

namespace Manso.Application;

public sealed class XrayContextService : IXrayContextService
{
    private readonly IXrayApiClient _xrayApiClient;
    private readonly XrayRetrievalOptions _options;
    private readonly ILogger<XrayContextService> _logger;

    public XrayContextService(
        IXrayApiClient xrayApiClient,
        XrayRetrievalOptions options,
        ILogger<XrayContextService> logger)
    {
        _xrayApiClient = xrayApiClient;
        _options = options;
        _logger = logger;
    }

    public async Task<XrayContextBundle> BuildAsync(
        NormalizedRunRequest request,
        JiraIssueContext issue,
        RepositoryTarget? repositoryTarget,
        RepositoryContextBundle? repositoryContext,
        CancellationToken ct)
    {
        if (!_options.Enabled)
        {
            return new XrayContextBundle(
                Array.Empty<XrayTestCase>(),
                [new RunWarning("xray_lookup_disabled", "Xray neighboring test lookup is disabled.")]);
        }

        var jql = BuildJql(request, issue);
        if (string.IsNullOrWhiteSpace(jql))
        {
            return new XrayContextBundle(
                Array.Empty<XrayTestCase>(),
                [new RunWarning("xray_jql_empty", "Xray neighboring test lookup produced an empty JQL query and was skipped.")]);
        }

        var tests = new List<XrayTestCase>();
        var providerRequestCount = 0;
        var searchRequests = BuildSearchRequests(request, issue, jql);
        foreach (var searchRequest in searchRequests)
        {
            ct.ThrowIfCancellationRequested();

            providerRequestCount++;
            var results = await _xrayApiClient.SearchTestsAsync(searchRequest, ct);
            tests.AddRange(results);
        }

        var deduplicated = tests
            .GroupBy(test => test.IssueId, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .ToArray();

        _logger.LogInformation(
            "Retrieved {TestCount} linked and neighboring Xray test(s) for issue {IssueKey} using base JQL: {Jql}.",
            deduplicated.Length,
            request.IssueKey,
            jql);

        return new XrayContextBundle(deduplicated, Array.Empty<RunWarning>())
        {
            ProviderRequestCount = providerRequestCount,
        };
    }

    private IReadOnlyList<XrayTestSearchRequest> BuildSearchRequests(
        NormalizedRunRequest request,
        JiraIssueContext issue,
        string primaryJql)
    {
        var searchRequests = new List<XrayTestSearchRequest>
        {
            new(primaryJql, _options.MaxNeighboringTests),
        };

        var linkedTestsJql = BuildLinkedTestsJql(request);
        if (!string.IsNullOrWhiteSpace(linkedTestsJql) &&
            !linkedTestsJql.Equals(primaryJql, StringComparison.OrdinalIgnoreCase))
        {
            searchRequests.Add(new XrayTestSearchRequest(linkedTestsJql, ResolveLinkedTestLimit(issue)));
        }

        var explicitLinkedKeysJql = BuildExplicitLinkedTestKeysJql(issue);
        if (!string.IsNullOrWhiteSpace(explicitLinkedKeysJql) &&
            !explicitLinkedKeysJql.Equals(primaryJql, StringComparison.OrdinalIgnoreCase) &&
            !explicitLinkedKeysJql.Equals(linkedTestsJql, StringComparison.OrdinalIgnoreCase))
        {
            searchRequests.Add(new XrayTestSearchRequest(explicitLinkedKeysJql, ResolveLinkedTestLimit(issue)));
        }

        return searchRequests;
    }

    private string BuildJql(
        NormalizedRunRequest request,
        JiraIssueContext issue)
    {
        var projectKey = ResolveProjectKey(request.IssueKey);
        var searchTerms = new List<string>();

        if (!string.IsNullOrWhiteSpace(request.IssueKey))
        {
            searchTerms.Add($"text ~ \"\\\"{EscapeJqlLiteral(request.IssueKey)}\\\"\"");
        }

        var issueSummary = NormalizeFreeText(issue.Summary);
        if (!string.IsNullOrWhiteSpace(issueSummary))
        {
            searchTerms.Add($"text ~ \"\\\"{EscapeJqlLiteral(issueSummary)}\\\"\"");
        }

        if (searchTerms.Count == 0)
        {
            return string.Empty;
        }

        var searchClause = searchTerms.Count == 1
            ? searchTerms[0]
            : $"({string.Join(" OR ", searchTerms)})";
        return $"project = {EscapeJqlLiteral(projectKey)} AND issuetype in (\"Test Case\", \"Test\") AND {searchClause} ORDER BY updated DESC";
    }

    private string BuildLinkedTestsJql(
        NormalizedRunRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.IssueKey))
        {
            return string.Empty;
        }

        var projectKey = ResolveProjectKey(request.IssueKey);
        return $"project = {EscapeJqlLiteral(projectKey)} AND issuetype in (\"Test Case\", \"Test\") AND issue in linkedIssues(\"{EscapeJqlLiteral(request.IssueKey)}\") ORDER BY created DESC";
    }

    private static string BuildExplicitLinkedTestKeysJql(JiraIssueContext issue)
    {
        var linkedTestIssueKeys = issue.LinkedIssues
            .Where(IsLinkedTestIssue)
            .Select(linkedIssue => linkedIssue.IssueKey)
            .Where(issueKey => !string.IsNullOrWhiteSpace(issueKey))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (linkedTestIssueKeys.Length == 0)
        {
            return string.Empty;
        }

        var joinedKeys = string.Join(", ", linkedTestIssueKeys.Select(issueKey => $"\"{EscapeJqlLiteral(issueKey)}\""));
        return $"key in ({joinedKeys}) ORDER BY updated DESC";
    }

    private static bool IsLinkedTestIssue(JiraLinkedIssue linkedIssue)
        => linkedIssue.IssueType.Equals("Test", StringComparison.OrdinalIgnoreCase) ||
           linkedIssue.IssueType.Equals("Test Case", StringComparison.OrdinalIgnoreCase);

    private int ResolveLinkedTestLimit(JiraIssueContext issue)
    {
        var linkedTestCount = issue.LinkedIssues
            .Where(IsLinkedTestIssue)
            .Select(linkedIssue => linkedIssue.IssueKey)
            .Where(issueKey => !string.IsNullOrWhiteSpace(issueKey))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Count();

        return Math.Max(_options.MaxNeighboringTests, linkedTestCount);
    }

    private static string NormalizeFreeText(string value)
        => Regex.Replace(value ?? string.Empty, "\\s+", " ").Trim();

    private static string EscapeJqlLiteral(string value)
        => (value ?? string.Empty).Replace("\"", "\\\"", StringComparison.Ordinal);

    private string ResolveProjectKey(string issueKey)
    {
        if (!string.IsNullOrWhiteSpace(issueKey))
        {
            var separatorIndex = issueKey.IndexOf('-', StringComparison.Ordinal);
            if (separatorIndex > 0)
            {
                return issueKey[..separatorIndex].Trim().ToUpperInvariant();
            }
        }

        throw new InvalidOperationException(
            $"Unable to resolve Xray project key from issue key '{issueKey}'.");
    }
}
