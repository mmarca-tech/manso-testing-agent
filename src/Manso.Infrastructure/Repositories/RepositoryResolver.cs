using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging;

namespace Manso.Infrastructure;

public sealed class RepositoryResolver : IRepositoryResolver
{
    private readonly IScmClient _scmClient;
    private readonly ILogger<RepositoryResolver> _logger;

    public RepositoryResolver(
        IScmClient scmClient,
        ILogger<RepositoryResolver> logger)
    {
        _scmClient = scmClient;
        _logger = logger;
    }

    public async Task<RepositoryTarget> ResolveAsync(
        JiraIssueContext issue,
        NormalizedRunRequest request,
        CancellationToken ct)
    {
        var baseTarget = ResolveRepositoryTarget(issue, request.RepositoryAlias);

        var developmentHint = ResolveHintFromDevelopmentInformation(baseTarget, issue);
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
                BaseBranch = baseTarget.DefaultBranch,
                ResolutionEvidence = resolutionEvidence,
                PullRequestIds = pullRequestIds,
                PullRequestReferences = pullRequestReferences,
            };

            _logger.LogInformation(
                "Resolved repository target {Alias} from {PullRequestCount} usable Jira development pull requests for issue {IssueKey}. PullRequestUrls: {PullRequestUrls}",
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
            BaseBranch = baseTarget.DefaultBranch,
            ResolutionEvidence = resolutionEvidence,
        };

        _logger.LogInformation(
            "Resolved repository target {Alias} from branch {BranchName} for issue {IssueKey}.",
            branchTarget.Alias,
            branchTarget.BranchName,
            issue.IssueKey);

        return branchTarget;
    }

    private RepositoryTarget ResolveRepositoryTarget(
        JiraIssueContext issue,
        string? requestedAlias)
    {
        if (issue.DevelopmentRepositories.Count == 0)
        {
            throw new RepositoryContextUnavailableException(
                $"Jira development information returned no repositories for issue '{issue.IssueKey}'.");
        }

        JiraDevelopmentRepository selectedRepository;
        if (!string.IsNullOrWhiteSpace(requestedAlias))
        {
            var matches = issue.DevelopmentRepositories
                .Where(repository => RepositoryMatchesRequestedAlias(repository, requestedAlias))
                .ToArray();
            if (matches.Length == 1)
            {
                selectedRepository = matches[0];
            }
            else if (matches.Length > 1)
            {
                throw new InvalidOperationException(
                    $"Repository alias '{requestedAlias}' matched multiple Jira development repositories: {string.Join(", ", matches.Select(repository => repository.Name))}.");
            }
            else
            {
                throw new RepositoryContextUnavailableException(
                    $"Jira development information only referenced different repositories: {string.Join(", ", issue.DevelopmentRepositories.Select(repository => repository.Name))}.");
            }
        }
        else if (issue.DevelopmentRepositories.Count == 1)
        {
            selectedRepository = issue.DevelopmentRepositories[0];
        }
        else
        {
            var repositoriesWithUsablePullRequests = issue.DevelopmentRepositories
                .Where(repository => repository.PullRequests.Any(pullRequest =>
                    IsUsablePullRequestStatus(pullRequest.Status) &&
                    !string.IsNullOrWhiteSpace(pullRequest.Url)))
                .ToArray();
            if (repositoriesWithUsablePullRequests.Length == 1)
            {
                selectedRepository = repositoriesWithUsablePullRequests[0];
            }
            else if (repositoriesWithUsablePullRequests.Length > 1)
            {
                throw new RepositoryContextUnavailableException(
                    $"Jira development information referenced multiple repositories with usable pull requests: {string.Join(", ", repositoriesWithUsablePullRequests.Select(repository => repository.Name))}.");
            }
            else
            {
                throw new RepositoryContextUnavailableException(
                    $"Jira development information referenced multiple repositories and did not uniquely identify one: {string.Join(", ", issue.DevelopmentRepositories.Select(repository => repository.Name))}.");
            }
        }

        var repositoryReference = ParseRepositoryReference(selectedRepository);
        return new RepositoryTarget(
            repositoryReference.RepositoryName,
            "AzureDevOps",
            repositoryReference.Organization,
            repositoryReference.Project,
            repositoryReference.RepositoryName,
            repositoryReference.RepositoryUrl,
            InferDefaultBranch(selectedRepository),
            null,
            InferDefaultBranch(selectedRepository),
            null,
            null,
            null,
            null,
            string.IsNullOrWhiteSpace(requestedAlias)
                ? "jira_development_repository"
                : "repository_alias");
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
        JiraIssueContext issue)
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

        var usablePullRequests = matchingRepositories
            .SelectMany(repository => repository.PullRequests)
            .Where(pullRequest => IsUsablePullRequestStatus(pullRequest.Status))
            .Where(pullRequest => !string.IsNullOrWhiteSpace(pullRequest.Url))
            .GroupBy(pullRequest => pullRequest.Url, StringComparer.OrdinalIgnoreCase)
            .Select(group => group
                .OrderByDescending(pullRequest => pullRequest.LastUpdatedUtc ?? DateTimeOffset.MinValue)
                .First())
            .ToArray();
        if (usablePullRequests.Length == 1)
        {
            _logger.LogInformation(
                "Resolved repository {RepositoryName} from unique usable Jira development pull request for issue {IssueKey}. PullRequestUrl: {PullRequestUrl}",
                target.RepositoryName,
                issue.IssueKey,
                usablePullRequests[0].Url);
            return new DevelopmentHintResolution(
                usablePullRequests[0].Url,
                null,
                "jira_development_pull_request");
        }

        if (usablePullRequests.Length > 1)
        {
            _logger.LogInformation(
                "Aggregated usable Jira development pull requests for repository {RepositoryName} on issue {IssueKey}. PullRequestUrls: {PullRequestUrls}",
                target.RepositoryName,
                issue.IssueKey,
                usablePullRequests.Select(pullRequest => pullRequest.Url).ToArray());
            return new DevelopmentHintResolution(
                null,
                null,
                "jira_development_pull_request_aggregate",
                usablePullRequests
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
                "Jira development information for repository {RepositoryName} on issue {IssueKey} contained no usable Jira development pull requests. AvailablePullRequestStatuses: {AvailablePullRequestStatuses}",
                target.RepositoryName,
                issue.IssueKey,
                availableStatuses);
        }

        _logger.LogInformation(
            "Jira development information matched repository {RepositoryName} for issue {IssueKey}, but no usable Jira development pull requests were present.",
            target.RepositoryName,
            issue.IssueKey);
        return new DevelopmentHintResolution(
            null,
            $"Repository '{target.Alias}' was resolved and Jira development information matched it, but no usable Jira development pull requests were present.",
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

    private static bool RepositoryMatchesRequestedAlias(
        JiraDevelopmentRepository repository,
        string requestedAlias)
    {
        if (repository.Name.Equals(requestedAlias, StringComparison.OrdinalIgnoreCase) ||
            repository.Name.EndsWith($"/{requestedAlias}", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (string.IsNullOrWhiteSpace(repository.Url) ||
            !Uri.TryCreate(repository.Url, UriKind.Absolute, out var repositoryUri))
        {
            return false;
        }

        var repositoryName = repositoryUri.AbsolutePath
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .LastOrDefault();
        return !string.IsNullOrWhiteSpace(repositoryName) &&
               repositoryName.Equals(requestedAlias, StringComparison.OrdinalIgnoreCase);
    }

    private static RepositoryReference ParseRepositoryReference(JiraDevelopmentRepository repository)
    {
        if (!string.IsNullOrWhiteSpace(repository.Url) &&
            Uri.TryCreate(repository.Url, UriKind.Absolute, out var repositoryUri) &&
            TryParseAzureDevOpsRepositoryUrl(repositoryUri, out var organization, out var project, out var repositoryName))
        {
            return new RepositoryReference(
                organization,
                project,
                repositoryName,
                $"https://dev.azure.com/{organization}/{project}/_git/{repositoryName}");
        }

        var nameParts = repository.Name
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (nameParts.Length >= 3)
        {
            var parsedOrganization = nameParts[0];
            var parsedProject = nameParts[1];
            var parsedRepositoryName = nameParts[^1];
            return new RepositoryReference(
                parsedOrganization,
                parsedProject,
                parsedRepositoryName,
                $"https://dev.azure.com/{parsedOrganization}/{parsedProject}/_git/{parsedRepositoryName}");
        }

        throw new RepositoryContextUnavailableException(
            $"Jira development repository '{repository.Name}' did not contain a parseable Azure DevOps repository reference.");
    }

    private static bool TryParseAzureDevOpsRepositoryUrl(
        Uri repositoryUri,
        out string organization,
        out string project,
        out string repositoryName)
    {
        organization = string.Empty;
        project = string.Empty;
        repositoryName = string.Empty;

        if (!repositoryUri.Host.Equals("dev.azure.com", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var segments = repositoryUri.AbsolutePath
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (segments.Length < 4 || !segments[2].Equals("_git", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        organization = segments[0];
        project = segments[1];
        repositoryName = segments[3];
        return !string.IsNullOrWhiteSpace(organization) &&
               !string.IsNullOrWhiteSpace(project) &&
               !string.IsNullOrWhiteSpace(repositoryName);
    }

    private static string InferDefaultBranch(JiraDevelopmentRepository repository)
    {
        var candidateBranches = repository.PullRequests
            .Select(pullRequest => NormalizeBranchName(pullRequest.DestinationBranchName ?? string.Empty))
            .Where(branch => !string.IsNullOrWhiteSpace(branch))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        if (candidateBranches.Any(branch => branch.Equals("main", StringComparison.OrdinalIgnoreCase)))
        {
            return "main";
        }

        if (candidateBranches.Any(branch => branch.Equals("master", StringComparison.OrdinalIgnoreCase)))
        {
            return "master";
        }

        if (candidateBranches.Length == 1)
        {
            return candidateBranches[0];
        }

        return "main";
    }

    private static bool IsUsablePullRequestStatus(string? status)
        => !IsRejectedOrAbandonedPullRequestStatus(status);

    private static bool IsRejectedOrAbandonedPullRequestStatus(string? status)
        => status is not null &&
           (status.Equals("DECLINED", StringComparison.OrdinalIgnoreCase) ||
            status.Equals("REJECTED", StringComparison.OrdinalIgnoreCase) ||
            status.Equals("ABANDONED", StringComparison.OrdinalIgnoreCase));

    private sealed record DevelopmentHintResolution(
        string? Hint,
        string? UnavailableReason,
        string? ResolutionEvidence,
        IReadOnlyList<string>? AggregatePullRequestHints = null);

    private sealed record RepositoryReference(
        string Organization,
        string Project,
        string RepositoryName,
        string RepositoryUrl);
}
