using Manso.Domain;
using Microsoft.Extensions.Logging;
using System.Text.RegularExpressions;

namespace Manso.Application;

public sealed class JiraContextService : IJiraContextService
{
    private static readonly Regex IssueKeyRegex = new("\\b[A-Z][A-Z0-9]+-\\d+\\b", RegexOptions.Compiled);
    private const int MaxDescriptionReferencedIssues = 10;

    private readonly IJiraApiClient _jiraApiClient;
    private readonly JiraRetrievalOptions _options;
    private readonly ILogger<JiraContextService> _logger;

    public JiraContextService(
        IJiraApiClient jiraApiClient,
        JiraRetrievalOptions options,
        ILogger<JiraContextService> logger)
    {
        _jiraApiClient = jiraApiClient;
        _options = options;
        _logger = logger;
    }

    public async Task<JiraIssueContext> BuildAsync(NormalizedRunRequest request, CancellationToken ct)
    {
        var issue = await _jiraApiClient.GetIssueContextAsync(
            request.IssueKey,
            _options.IncludeComments,
            _options.MaxComments,
            ct);

        if (string.IsNullOrWhiteSpace(issue.Summary))
        {
            throw new InvalidOperationException($"Jira issue '{request.IssueKey}' returned an empty summary.");
        }

        if (string.IsNullOrWhiteSpace(issue.Description) && string.IsNullOrWhiteSpace(issue.AcceptanceCriteria))
        {
            throw new InvalidOperationException(
                $"Jira issue '{request.IssueKey}' returned no description or acceptance criteria.");
        }

        var descriptionReferencedIssues = await ResolveDescriptionReferencedIssuesAsync(issue, ct);
        if (descriptionReferencedIssues.Count > 0)
        {
            issue = issue with
            {
                DescriptionReferencedIssues = descriptionReferencedIssues,
            };
        }

        _logger.LogInformation(
            "Built Jira context for issue {IssueKey} with {CommentCount} comments, {LinkedIssueCount} linked issues, {DevelopmentRepositoryCount} development repository entries, and {ReferencedIssueCount} description-referenced issues.",
            issue.IssueKey,
            issue.Comments.Count,
            issue.LinkedIssueKeys.Count,
            issue.DevelopmentRepositories.Count,
            issue.DescriptionReferencedIssues.Count);

        return issue;
    }

    private async Task<IReadOnlyList<JiraReferencedIssueContext>> ResolveDescriptionReferencedIssuesAsync(
        JiraIssueContext issue,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(issue.Description))
        {
            return Array.Empty<JiraReferencedIssueContext>();
        }

        var referencedIssueKeys = IssueKeyRegex.Matches(issue.Description)
            .Select(match => match.Value)
            .Where(issueKey => !issueKey.Equals(issue.IssueKey, StringComparison.OrdinalIgnoreCase))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(MaxDescriptionReferencedIssues)
            .ToArray();

        if (referencedIssueKeys.Length == 0)
        {
            return Array.Empty<JiraReferencedIssueContext>();
        }

        var referencedIssues = new List<JiraReferencedIssueContext>(referencedIssueKeys.Length);
        foreach (var referencedIssueKey in referencedIssueKeys)
        {
            try
            {
                var referencedIssue = await _jiraApiClient.GetIssueContextAsync(
                    referencedIssueKey,
                    includeComments: false,
                    maxComments: 0,
                    ct);

                if (string.IsNullOrWhiteSpace(referencedIssue.Summary) &&
                    string.IsNullOrWhiteSpace(referencedIssue.Description))
                {
                    continue;
                }

                referencedIssues.Add(new JiraReferencedIssueContext(
                    referencedIssue.IssueKey,
                    referencedIssue.Summary,
                    referencedIssue.Description));
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    ex,
                    "Skipping Jira issue {ReferencedIssueKey} referenced from description of issue {IssueKey} because its context could not be loaded.",
                    referencedIssueKey,
                    issue.IssueKey);
            }
        }

        return referencedIssues;
    }
}
