using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Manso.Infrastructure;

public sealed class RepositoryResolver : IRepositoryResolver
{
    private readonly RepoAdapterOptions _repoOptions;
    private readonly IScmClient _scmClient;
    private readonly ILogger<RepositoryResolver> _logger;

    public RepositoryResolver(
        IOptions<RepoAdapterOptions> repoOptions,
        IScmClient scmClient,
        ILogger<RepositoryResolver> logger)
    {
        _repoOptions = repoOptions.Value;
        _scmClient = scmClient;
        _logger = logger;
    }

    public async Task<RepositoryTarget> ResolveAsync(
        JiraIssueContext issue,
        NormalizedRunRequest request,
        CancellationToken ct)
    {
        var repository = ResolveRepositoryDefinition(request.RepositoryAlias);
        var baseTarget = new RepositoryTarget(
            repository.Key,
            repository.Value.Provider,
            repository.Value.Organization,
            repository.Value.Project,
            repository.Value.RepositoryName,
            repository.Value.RepositoryUrl,
            repository.Value.DefaultBranch,
            null,
            repository.Value.DefaultBranch,
            null,
            null,
            null,
            null,
            request.RepositoryAlias is null ? "single_configured_repository" : "repository_alias");

        var developmentHint = ResolveHintFromDevelopmentInformation(baseTarget, issue, request);
        var hint = developmentHint.Hint;
        var aggregatePullRequestHints = developmentHint.AggregatePullRequestHints ?? Array.Empty<string>();
        var unavailableReason = developmentHint.UnavailableReason;
        var resolutionEvidence = developmentHint.ResolutionEvidence ?? string.Empty;

        if (aggregatePullRequestHints.Count > 0)
        {
            var pullRequestIds = new List<int>(aggregatePullRequestHints.Count);
            var pullRequestReferences = new List<string>(aggregatePullRequestHints.Count);
            foreach (var pullRequestHint in aggregatePullRequestHints)
            {
                if (!TryParsePullRequestHint(baseTarget, pullRequestHint, out var aggregatePullRequestId, out var aggregatePullRequestReference))
                {
                    throw new InvalidOperationException(
                        $"Jira development pull request URL '{pullRequestHint}' could not be parsed for repository '{baseTarget.RepositoryName}'.");
                }

                pullRequestIds.Add(aggregatePullRequestId);
                pullRequestReferences.Add(aggregatePullRequestReference ?? pullRequestHint);
            }

            var resolved = baseTarget with
            {
                BaseBranch = repository.Value.DefaultBranch,
                ResolutionEvidence = resolutionEvidence,
                PullRequestIds = pullRequestIds,
                PullRequestReferences = pullRequestReferences,
            };

            _logger.LogInformation(
                "Resolved repository target {Alias} from {PullRequestCount} merged Jira development pull requests for issue {IssueKey}. PullRequestUrls: {PullRequestUrls}",
                resolved.Alias,
                resolved.PullRequestIds.Count,
                issue.IssueKey,
                resolved.PullRequestReferences.ToArray());

            return resolved;
        }

        if (string.IsNullOrWhiteSpace(hint))
        {
            throw new RepositoryContextUnavailableException(
                unavailableReason ??
                $"Repository '{baseTarget.Alias}' was resolved, but neither an explicit PR/branch hint nor a unique Jira development reference was available.");
        }

        if (TryParsePullRequestHint(baseTarget, hint, out var pullRequestId, out var pullRequestReference))
        {
            var pullRequest = await _scmClient.GetPullRequestAsync(baseTarget, pullRequestId, ct);
            var resolved = baseTarget with
            {
                BranchName = pullRequest.SourceBranch,
                BaseBranch = pullRequest.TargetBranch,
                PullRequestId = pullRequest.PullRequestId,
                PullRequestReference = pullRequestReference ?? pullRequest.PullRequestReference,
                SourceCommitSha = pullRequest.SourceCommitSha,
                TargetCommitSha = pullRequest.TargetCommitSha,
                ResolutionEvidence = resolutionEvidence,
                PullRequestIds = [pullRequest.PullRequestId],
                PullRequestReferences =
                [
                    pullRequestReference ?? pullRequest.PullRequestReference,
                ],
            };

            _logger.LogInformation(
                "Resolved repository target {Alias} from PR {PullRequestId} for issue {IssueKey}.",
                resolved.Alias,
                resolved.PullRequestId,
                issue.IssueKey);

            return resolved;
        }

        var branchName = NormalizeBranchName(hint);
        if (string.IsNullOrWhiteSpace(branchName))
        {
            throw new InvalidOperationException(
                $"Repository hint '{hint}' could not be interpreted as a supported PR URL or branch name.");
        }

        var branchTarget = baseTarget with
        {
            BranchName = branchName,
            BaseBranch = repository.Value.DefaultBranch,
            ResolutionEvidence = resolutionEvidence,
        };

        _logger.LogInformation(
            "Resolved repository target {Alias} from branch {BranchName} for issue {IssueKey}.",
            branchTarget.Alias,
            branchTarget.BranchName,
            issue.IssueKey);

        return branchTarget;
    }

    private KeyValuePair<string, RepoDefinition> ResolveRepositoryDefinition(string? requestedAlias)
    {
        if (!string.IsNullOrWhiteSpace(requestedAlias))
        {
            if (_repoOptions.Repositories.TryGetValue(requestedAlias, out var repository))
            {
                return new KeyValuePair<string, RepoDefinition>(requestedAlias, repository);
            }

            throw new InvalidOperationException(
                $"Repository alias '{requestedAlias}' is not configured for this environment.");
        }

        if (_repoOptions.Repositories.Count == 1)
        {
            return _repoOptions.Repositories.Single();
        }

        throw new InvalidOperationException(
            "Repository alias was not supplied and multiple repositories are configured; refusing to guess.");
    }

    private static bool TryParsePullRequestHint(
        RepositoryTarget target,
        string hint,
        out int pullRequestId,
        out string? pullRequestReference)
    {
        pullRequestId = 0;
        pullRequestReference = null;

        if (!Uri.TryCreate(hint, UriKind.Absolute, out var uri))
        {
            return false;
        }

        if (!Uri.TryCreate(target.RepositoryUrl, UriKind.Absolute, out var repositoryUri))
        {
            return false;
        }

        if (!uri.Host.Equals(repositoryUri.Host, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var absoluteUri = uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
        var repositoryRoot = repositoryUri.GetLeftPart(UriPartial.Path).TrimEnd('/');
        if (!absoluteUri.StartsWith(repositoryRoot, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var segments = uri.AbsolutePath
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var pullRequestIndex = Array.FindIndex(
            segments,
            segment => segment.Equals("pullrequest", StringComparison.OrdinalIgnoreCase));
        if (pullRequestIndex >= 0 &&
            pullRequestIndex + 1 < segments.Length &&
            int.TryParse(segments[pullRequestIndex + 1], out pullRequestId))
        {
            pullRequestReference = hint.Trim();
            return true;
        }

        return false;
    }

    private static string NormalizeBranchName(string hint)
    {
        var value = hint.Trim();
        if (Uri.TryCreate(value, UriKind.Absolute, out _))
        {
            return string.Empty;
        }

        if (value.StartsWith("refs/heads/", StringComparison.OrdinalIgnoreCase))
        {
            return value["refs/heads/".Length..];
        }

        return value;
    }

    private DevelopmentHintResolution ResolveHintFromDevelopmentInformation(
        RepositoryTarget target,
        JiraIssueContext issue,
        NormalizedRunRequest request)
    {
        if (issue.DevelopmentRepositories.Count == 0)
        {
            _logger.LogInformation(
                "No Jira development repositories were available for issue {IssueKey} while resolving repository {RepositoryName}.",
                issue.IssueKey,
                target.RepositoryName);
            return new DevelopmentHintResolution(
                null,
                $"Repository '{target.Alias}' was resolved, but Jira development information returned no repositories for issue '{issue.IssueKey}'.",
                null);
        }

        var matchingRepositories = issue.DevelopmentRepositories
            .Where(repository => RepositoryMatchesTarget(repository, target))
            .ToArray();
        if (matchingRepositories.Length == 0)
        {
            _logger.LogInformation(
                "Jira development repositories did not match configured repository {RepositoryName} for issue {IssueKey}. AvailableRepositories: {AvailableRepositories}",
                target.RepositoryName,
                issue.IssueKey,
                issue.DevelopmentRepositories.Select(repository => repository.Name).ToArray());
            return new DevelopmentHintResolution(
                null,
                $"Repository '{target.Alias}' was resolved, but Jira development information only referenced different repositories: {string.Join(", ", issue.DevelopmentRepositories.Select(repository => repository.Name))}.",
                null);
        }

        var mergedPullRequests = matchingRepositories
            .SelectMany(repository => repository.PullRequests)
            .Where(pullRequest => IsMergedPullRequestStatus(pullRequest.Status))
            .Where(pullRequest => !string.IsNullOrWhiteSpace(pullRequest.Url))
            .GroupBy(pullRequest => pullRequest.Url, StringComparer.OrdinalIgnoreCase)
            .Select(group => group
                .OrderByDescending(pullRequest => pullRequest.LastUpdatedUtc ?? DateTimeOffset.MinValue)
                .First())
            .ToArray();
        if (mergedPullRequests.Length == 1)
        {
            _logger.LogInformation(
                "Resolved repository {RepositoryName} from unique merged Jira development pull request for issue {IssueKey}. PullRequestUrl: {PullRequestUrl}",
                target.RepositoryName,
                issue.IssueKey,
                mergedPullRequests[0].Url);
            return new DevelopmentHintResolution(
                mergedPullRequests[0].Url,
                null,
                "jira_development_pull_request");
        }

        if (mergedPullRequests.Length > 1)
        {
            _logger.LogInformation(
                "{WorkflowPass} aggregated merged Jira development pull requests for repository {RepositoryName} on issue {IssueKey}. PullRequestUrls: {PullRequestUrls}",
                request.WorkflowPass,
                target.RepositoryName,
                issue.IssueKey,
                mergedPullRequests.Select(pullRequest => pullRequest.Url).ToArray());
            return new DevelopmentHintResolution(
                null,
                null,
                "jira_development_merged_pull_request_aggregate",
                mergedPullRequests
                    .OrderBy(pullRequest => pullRequest.LastUpdatedUtc ?? DateTimeOffset.MinValue)
                    .ThenBy(pullRequest => pullRequest.Url, StringComparer.OrdinalIgnoreCase)
                    .Select(pullRequest => pullRequest.Url)
                    .ToArray());
        }

        var availableStatuses = matchingRepositories
            .SelectMany(repository => repository.PullRequests)
            .Select(pullRequest => pullRequest.Status)
            .Where(status => !string.IsNullOrWhiteSpace(status))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Cast<string>()
            .ToArray();
        if (availableStatuses.Length > 0)
        {
            _logger.LogInformation(
                "Jira development information for repository {RepositoryName} on issue {IssueKey} contained no usable merged pull requests. AvailablePullRequestStatuses: {AvailablePullRequestStatuses}",
                target.RepositoryName,
                issue.IssueKey,
                availableStatuses);
        }

        _logger.LogInformation(
            "Jira development information matched repository {RepositoryName} for issue {IssueKey}, but no usable merged pull requests were present.",
            target.RepositoryName,
            issue.IssueKey);
        return new DevelopmentHintResolution(
            null,
            $"Repository '{target.Alias}' was resolved and Jira development information matched it, but no usable merged pull requests were present.",
            null);
    }

    private static bool RepositoryMatchesTarget(JiraDevelopmentRepository repository, RepositoryTarget target)
    {
        if (!string.IsNullOrWhiteSpace(repository.Url) &&
            repository.Url.Equals(target.RepositoryUrl, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (repository.Name.Equals(target.RepositoryName, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return repository.Name.EndsWith($"/{target.RepositoryName}", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsMergedPullRequestStatus(string? status)
        => status is not null &&
           (status.Equals("MERGED", StringComparison.OrdinalIgnoreCase) ||
            status.Equals("COMPLETED", StringComparison.OrdinalIgnoreCase));

    private sealed record DevelopmentHintResolution(
        string? Hint,
        string? UnavailableReason,
        string? ResolutionEvidence,
        IReadOnlyList<string>? AggregatePullRequestHints = null);
}
