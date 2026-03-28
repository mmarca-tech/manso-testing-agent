using Manso.Domain;
using Microsoft.Extensions.Logging;

namespace Manso.Application;

public sealed class JiraContextService : IJiraContextService
{
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

        _logger.LogInformation(
            "Built Jira context for issue {IssueKey} with {CommentCount} comments, {LinkedIssueCount} linked issues, and {DevelopmentRepositoryCount} development repository entries.",
            issue.IssueKey,
            issue.Comments.Count,
            issue.LinkedIssueKeys.Count,
            issue.DevelopmentRepositories.Count);

        return issue;
    }
}
