using System.Text.RegularExpressions;
using Manso.Domain;
using Microsoft.Extensions.Logging;

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

        var jql = BuildJql(request, issue, repositoryTarget, repositoryContext);
        if (string.IsNullOrWhiteSpace(jql))
        {
            return new XrayContextBundle(
                Array.Empty<XrayTestCase>(),
                [new RunWarning("xray_jql_empty", "Xray neighboring test lookup produced an empty JQL query and was skipped.")]);
        }

        var tests = await _xrayApiClient.SearchTestsAsync(
            new XrayTestSearchRequest(jql, _options.MaxNeighboringTests),
            ct);

        var deduplicated = tests
            .GroupBy(test => test.IssueId, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .ToArray();

        _logger.LogInformation(
            "Retrieved {TestCount} neighboring Xray test(s) for issue {IssueKey} using JQL: {Jql}.",
            deduplicated.Length,
            request.IssueKey,
            jql);

        return new XrayContextBundle(deduplicated, Array.Empty<RunWarning>());
    }

    private string BuildJql(
        NormalizedRunRequest request,
        JiraIssueContext issue,
        RepositoryTarget? repositoryTarget,
        RepositoryContextBundle? repositoryContext)
    {
        var linkedKeys = issue.LinkedIssueKeys.Count == 0
            ? request.IssueKey
            : string.Join(", ", issue.LinkedIssueKeys.Distinct(StringComparer.OrdinalIgnoreCase));
        var changedPaths = repositoryContext is null || repositoryContext.ChangedFiles.Count == 0
            ? string.Empty
            : string.Join(", ", repositoryContext.ChangedFiles.Select(change => change.Path));
        var projectKey = ResolveProjectKey(request.IssueKey);

        return _options.SearchJqlTemplate
            .Replace("{XRAY_PROJECT_KEY}", EscapeJqlLiteral(projectKey), StringComparison.Ordinal)
            .Replace("{ISSUE_KEY}", EscapeJqlLiteral(request.IssueKey), StringComparison.Ordinal)
            .Replace("{ISSUE_SUMMARY}", EscapeJqlLiteral(NormalizeFreeText(issue.Summary)), StringComparison.Ordinal)
            .Replace("{LINKED_KEYS}", EscapeJqlLiteral(linkedKeys), StringComparison.Ordinal)
            .Replace("{REPOSITORY_ALIAS}", EscapeJqlLiteral(request.RepositoryAlias ?? repositoryTarget?.Alias ?? string.Empty), StringComparison.Ordinal)
            .Replace("{CHANGED_PATHS}", EscapeJqlLiteral(changedPaths), StringComparison.Ordinal);
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

        if (!string.IsNullOrWhiteSpace(_options.ProjectKey))
        {
            return _options.ProjectKey.Trim().ToUpperInvariant();
        }

        throw new InvalidOperationException(
            $"Unable to resolve Xray project key from issue key '{issueKey}'.");
    }
}
