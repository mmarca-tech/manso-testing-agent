using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Manso.Infrastructure;

public sealed class AzureDevOpsScmClient : IScmClient
{
    private static readonly string[] TextExtensions =
    [
        ".cs", ".csproj", ".props", ".targets", ".json", ".yml", ".yaml", ".xml", ".md", ".txt",
        ".feature", ".sql", ".js", ".jsx", ".ts", ".tsx"
    ];

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IOptions<ScmOptions> _options;
    private readonly ILogger<AzureDevOpsScmClient> _logger;

    public AzureDevOpsScmClient(
        IHttpClientFactory httpClientFactory,
        IOptions<ScmOptions> options,
        ILogger<AzureDevOpsScmClient> logger)
    {
        _httpClientFactory = httpClientFactory;
        _options = options;
        _logger = logger;
    }

    public async Task<RepositoryPullRequest> GetPullRequestAsync(
        RepositoryTarget repository,
        int pullRequestId,
        CancellationToken ct)
    {
        EnsureProviderSupported(repository);

        using var request = CreateRequest(HttpMethod.Get, BuildPullRequestPath(repository, pullRequestId));
        using var response = await SendAsync(request, ct);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        var root = document.RootElement;

        return new RepositoryPullRequest(
            root.GetProperty("pullRequestId").GetInt32(),
            $"{repository.RepositoryUrl.TrimEnd('/')}/pullrequest/{pullRequestId}",
            NormalizeRefName(root.GetProperty("sourceRefName").GetString()),
            NormalizeRefName(root.GetProperty("targetRefName").GetString()),
            TryGetNestedString(root, "lastMergeSourceCommit", "commitId"),
            TryGetNestedString(root, "lastMergeTargetCommit", "commitId"),
            root.TryGetProperty("status", out var statusElement) ? statusElement.GetString() ?? string.Empty : string.Empty);
    }

    public async Task<RepositoryContextBundle> GetCodeContextAsync(
        RepositoryTarget target,
        RepositoryRetrievalOptions options,
        RepositoryConventions conventions,
        CancellationToken ct)
    {
        EnsureProviderSupported(target);

        var diffResponse = target.PullRequestIds.Count > 1
            ? await GetAggregatedPullRequestDiffAsync(target, options, conventions, ct)
            : target.PullRequestId is not null
                ? await GetPullRequestDiffAsync(target, options, conventions, ct)
                : await GetBranchDiffAsync(target, options, conventions, ct);

        return diffResponse;
    }

    public async Task<RepositoryWriteExecutionResult> WriteAsync(
        RepositoryTarget target,
        RepositoryWritePlan plan,
        CancellationToken ct)
    {
        EnsureProviderSupported(target);

        var baseBranchHead = await GetBranchObjectIdAsync(target, plan.BaseBranch, ct);
        var commitId = await CreateBranchPushAsync(target, plan, baseBranchHead, ct);
        string? pullRequestUrl = null;

        if (plan.CreateDraftPullRequest)
        {
            pullRequestUrl = await CreateDraftPullRequestAsync(target, plan, ct);
        }

        return new RepositoryWriteExecutionResult(
            plan.NewBranchName,
            commitId,
            pullRequestUrl);
    }

    private async Task<RepositoryContextBundle> GetAggregatedPullRequestDiffAsync(
        RepositoryTarget target,
        RepositoryRetrievalOptions options,
        RepositoryConventions conventions,
        CancellationToken ct)
    {
        if (target.PullRequestIds.Count != target.PullRequestReferences.Count)
        {
            throw new InvalidOperationException(
                $"Repository target '{target.Alias}' has inconsistent merged pull request identifiers.");
        }

        var aggregatedEntries = new List<AggregatedChangeEntry>();
        var warnings = new List<RunWarning>();

        for (var index = 0; index < target.PullRequestIds.Count; index++)
        {
            ct.ThrowIfCancellationRequested();

            var pullRequestId = target.PullRequestIds[index];
            var pullRequestReference = target.PullRequestReferences[index];
            var pullRequest = await GetPullRequestAsync(target, pullRequestId, ct);
            if (string.IsNullOrWhiteSpace(pullRequest.SourceCommitSha) || string.IsNullOrWhiteSpace(pullRequest.TargetCommitSha))
            {
                throw new InvalidOperationException(
                    $"Pull request '{pullRequestReference}' is missing source or target commit identifiers.");
            }

            var pullRequestTarget = target with
            {
                BranchName = pullRequest.SourceBranch,
                BaseBranch = pullRequest.TargetBranch,
                PullRequestId = pullRequest.PullRequestId,
                PullRequestReference = pullRequestReference,
                SourceCommitSha = pullRequest.SourceCommitSha,
                TargetCommitSha = pullRequest.TargetCommitSha,
                PullRequestIds = [pullRequest.PullRequestId],
                PullRequestReferences = [pullRequestReference],
            };

            var diff = await GetDiffChangesAsync(
                pullRequestTarget,
                pullRequest.TargetCommitSha,
                "commit",
                pullRequest.SourceCommitSha,
                "commit",
                options,
                ct);

            warnings.AddRange(diff.Warnings);
            aggregatedEntries.AddRange(diff.ChangedFiles.Select(change => new AggregatedChangeEntry(
                pullRequestReference,
                pullRequestId,
                change)));
        }

        var mergedChanges = MergePullRequestChanges(aggregatedEntries, options.MaxChangedFiles, warnings);

        return await BuildContextBundleAsync(
            target,
            conventions,
            mergedChanges,
            warnings,
            target.DefaultBranch,
            "branch",
            options,
            ct);
    }

    private async Task<RepositoryContextBundle> GetPullRequestDiffAsync(
        RepositoryTarget target,
        RepositoryRetrievalOptions options,
        RepositoryConventions conventions,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(target.SourceCommitSha) || string.IsNullOrWhiteSpace(target.TargetCommitSha))
        {
            throw new InvalidOperationException(
                $"Pull request '{target.PullRequestReference}' is missing source or target commit identifiers.");
        }

        var diff = await GetDiffChangesAsync(
            target,
            target.TargetCommitSha,
            "commit",
            target.SourceCommitSha,
            "commit",
            options,
            ct);

        return await BuildContextBundleAsync(
            target,
            conventions,
            diff.ChangedFiles,
            diff.Warnings,
            target.SourceCommitSha,
            "commit",
            options,
            ct);
    }

    private async Task<RepositoryContextBundle> GetBranchDiffAsync(
        RepositoryTarget target,
        RepositoryRetrievalOptions options,
        RepositoryConventions conventions,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(target.BranchName))
        {
            throw new InvalidOperationException("Branch-based code context retrieval requires a branch name.");
        }

        var baseBranch = string.IsNullOrWhiteSpace(target.BaseBranch)
            ? target.DefaultBranch
            : target.BaseBranch;

        var diff = await GetDiffChangesAsync(
            target,
            baseBranch,
            "branch",
            target.BranchName,
            "branch",
            options,
            ct);

        return await BuildContextBundleAsync(
            target,
            conventions,
            diff.ChangedFiles,
            diff.Warnings,
            target.BranchName,
            "branch",
            options,
            ct);
    }

    private async Task<DiffFetchResult> GetDiffChangesAsync(
        RepositoryTarget target,
        string baseVersion,
        string baseVersionType,
        string targetVersion,
        string targetVersionType,
        RepositoryRetrievalOptions options,
        CancellationToken ct)
    {
        var warnings = new List<RunWarning>();
        var fileChanges = new List<RepositoryFileChange>();
        var skip = 0;
        var truncated = false;

        while (fileChanges.Count < options.MaxChangedFiles)
        {
            var path = BuildDiffPath(
                target,
                baseVersion,
                baseVersionType,
                targetVersion,
                targetVersionType,
                options.MaxChangedFiles,
                skip);

            using var request = CreateRequest(HttpMethod.Get, path);
            using var response = await SendAsync(request, ct);
            response.EnsureSuccessStatusCode();

            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var document = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
            var root = document.RootElement;

            var changes = root.TryGetProperty("changes", out var changesElement) && changesElement.ValueKind == JsonValueKind.Array
                ? changesElement.EnumerateArray().ToArray()
                : Array.Empty<JsonElement>();
            if (changes.Length == 0)
            {
                break;
            }

            var allChangesIncluded = !root.TryGetProperty("allChangesIncluded", out var allChangesIncludedElement) ||
                                     allChangesIncludedElement.ValueKind != JsonValueKind.False;

            for (var index = 0; index < changes.Length; index++)
            {
                ct.ThrowIfCancellationRequested();

                var change = changes[index];
                var item = change.GetProperty("item");
                var pathValue = item.TryGetProperty("path", out var pathElement)
                    ? pathElement.GetString() ?? string.Empty
                    : string.Empty;
                if (string.IsNullOrWhiteSpace(pathValue))
                {
                    continue;
                }

                if (IsFolderItem(item))
                {
                    continue;
                }

                var changeKind = MapChangeKind(change.TryGetProperty("changeType", out var changeTypeElement)
                    ? changeTypeElement.GetString()
                    : null);
                var previousPath = change.TryGetProperty("originalPath", out var originalPathElement)
                    ? originalPathElement.GetString()
                    : null;
                var effectivePreviousPath = string.IsNullOrWhiteSpace(previousPath) ? pathValue : previousPath;

                string? diffPreview = null;
                if (IsTextFile(pathValue) || (effectivePreviousPath is not null && IsTextFile(effectivePreviousPath)))
                {
                    var beforeContent = changeKind is RepositoryChangeKind.Added
                        ? null
                        : await TryGetFileContentAsync(target, effectivePreviousPath, baseVersion, baseVersionType, ct);
                    var afterContent = changeKind is RepositoryChangeKind.Deleted
                        ? null
                        : await TryGetFileContentAsync(target, pathValue, targetVersion, targetVersionType, ct);
                    diffPreview = UnifiedDiffBuilder.Build(pathValue, beforeContent, afterContent, options.MaxDiffLinesPerFile);
                }
                else
                {
                    warnings.Add(new RunWarning(
                        "non_text_change_skipped",
                        $"Skipped diff preview for non-text file '{pathValue}'."));
                }

                fileChanges.Add(new RepositoryFileChange(
                    pathValue,
                    changeKind,
                    IsTestFile(pathValue),
                    previousPath,
                    diffPreview));

                if (fileChanges.Count >= options.MaxChangedFiles)
                {
                    truncated = HasRemainingFileChanges(changes, index + 1) || !allChangesIncluded;
                    break;
                }
            }

            if (truncated || allChangesIncluded)
            {
                break;
            }

            skip += changes.Length;
        }

        if (truncated)
        {
            warnings.Add(new RunWarning(
                "changed_files_truncated",
                $"Changed file list was truncated to the configured limit of {options.MaxChangedFiles} file(s)."));
        }

        return new DiffFetchResult(fileChanges, warnings);
    }

    private async Task<RepositoryContextBundle> BuildContextBundleAsync(
        RepositoryTarget target,
        RepositoryConventions conventions,
        IReadOnlyList<RepositoryFileChange> fileChanges,
        IReadOnlyList<RunWarning> warnings,
        string version,
        string versionType,
        RepositoryRetrievalOptions options,
        CancellationToken ct)
    {
        var neighboringTests = await FindNeighboringTestsAsync(
            target,
            conventions,
            fileChanges,
            version,
            versionType,
            options,
            ct);

        return new RepositoryContextBundle(
            target,
            conventions,
            fileChanges,
            neighboringTests,
            string.Join(
                Environment.NewLine + Environment.NewLine,
                fileChanges
                    .Select(change => change.DiffPreview)
                    .Where(preview => !string.IsNullOrWhiteSpace(preview))),
            warnings);
    }

    private static IReadOnlyList<RepositoryFileChange> MergePullRequestChanges(
        IReadOnlyList<AggregatedChangeEntry> aggregatedEntries,
        int maxChangedFiles,
        IList<RunWarning> warnings)
    {
        var groupedEntries = aggregatedEntries
            .GroupBy(entry => NormalizePath(entry.Change.Path), StringComparer.OrdinalIgnoreCase)
            .ToArray();

        if (groupedEntries.Length > maxChangedFiles)
        {
            warnings.Add(new RunWarning(
                "changed_files_truncated",
                $"Aggregated merged pull request changes were truncated to the configured limit of {maxChangedFiles} file(s)."));
        }

        return groupedEntries
            .Take(maxChangedFiles)
            .Select(group =>
            {
                var orderedEntries = group
                    .OrderBy(entry => entry.PullRequestId)
                    .ThenBy(entry => entry.PullRequestReference, StringComparer.OrdinalIgnoreCase)
                    .ToArray();
                var first = orderedEntries[0].Change;
                var changeKind = orderedEntries
                    .Select(entry => entry.Change.ChangeKind)
                    .Distinct()
                    .Count() == 1
                    ? first.ChangeKind
                    : RepositoryChangeKind.Modified;
                var diffPreview = string.Join(
                    Environment.NewLine + Environment.NewLine,
                    orderedEntries
                        .Where(entry => !string.IsNullOrWhiteSpace(entry.Change.DiffPreview))
                        .Select(entry =>
                            $"Pull Request: {entry.PullRequestReference}{Environment.NewLine}{entry.Change.DiffPreview}"));

                return new RepositoryFileChange(
                    first.Path,
                    changeKind,
                    orderedEntries.Any(entry => entry.Change.IsTestFile),
                    orderedEntries.Select(entry => entry.Change.PreviousPath).FirstOrDefault(path => !string.IsNullOrWhiteSpace(path)),
                    string.IsNullOrWhiteSpace(diffPreview) ? null : diffPreview);
            })
            .ToArray();
    }

    private async Task<IReadOnlyList<NeighboringTestFile>> FindNeighboringTestsAsync(
        RepositoryTarget target,
        RepositoryConventions conventions,
        IReadOnlyList<RepositoryFileChange> fileChanges,
        string version,
        string versionType,
        RepositoryRetrievalOptions options,
        CancellationToken ct)
    {
        var changedPaths = new HashSet<string>(
            fileChanges.Select(change => NormalizePath(change.Path)),
            StringComparer.OrdinalIgnoreCase);
        var candidateRoots = BuildCandidateSearchRoots(fileChanges, conventions);
        var candidates = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var root in candidateRoots)
        {
            ct.ThrowIfCancellationRequested();

            foreach (var candidatePath in await ListPathsAsync(target, root, version, versionType, ct))
            {
                var normalizedCandidate = NormalizePath(candidatePath);
                if (changedPaths.Contains(normalizedCandidate) || !IsTestFile(normalizedCandidate))
                {
                    continue;
                }

                candidates.TryAdd(normalizedCandidate, BuildMatchReason(root));
            }
        }

        var rankedPaths = candidates.Keys
            .OrderBy(path => ScoreNeighboringTestPath(path, fileChanges))
            .ThenBy(path => path, StringComparer.OrdinalIgnoreCase)
            .Take(options.MaxNeighboringTests)
            .ToArray();

        var results = new List<NeighboringTestFile>(rankedPaths.Length);
        foreach (var path in rankedPaths)
        {
            var content = await TryGetFileContentAsync(target, path, version, versionType, ct);
            if (string.IsNullOrWhiteSpace(content))
            {
                continue;
            }

            results.Add(new NeighboringTestFile(
                path,
                candidates[path],
                TrimContentLines(content, options.MaxNeighboringTestLines)));
        }

        return results;
    }

    private async Task<string?> TryGetFileContentAsync(
        RepositoryTarget target,
        string? path,
        string version,
        string versionType,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return null;
        }

        var itemPath =
            $"{BuildRepositoryBasePath(target)}/items?path={Uri.EscapeDataString(path)}" +
            $"&includeContent=true&versionDescriptor.version={Uri.EscapeDataString(version)}" +
            $"&versionDescriptor.versionType={Uri.EscapeDataString(versionType)}&api-version=7.1";

        using var request = CreateRequest(HttpMethod.Get, itemPath);
        using var response = await SendAsync(request, ct);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        return document.RootElement.TryGetProperty("content", out var contentElement)
            ? SensitiveContentRedactor.Redact(path, contentElement.GetString())
            : null;
    }

    private async Task<IReadOnlyList<string>> ListPathsAsync(
        RepositoryTarget target,
        string scopePath,
        string version,
        string versionType,
        CancellationToken ct)
    {
        var itemPath =
            $"{BuildRepositoryBasePath(target)}/items?scopePath={Uri.EscapeDataString(scopePath)}" +
            $"&recursionLevel=Full&includeContentMetadata=true&latestProcessedChange=true" +
            $"&versionDescriptor.version={Uri.EscapeDataString(version)}" +
            $"&versionDescriptor.versionType={Uri.EscapeDataString(versionType)}&api-version=7.1";

        using var request = CreateRequest(HttpMethod.Get, itemPath);
        using var response = await SendAsync(request, ct);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return Array.Empty<string>();
        }

        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        if (!document.RootElement.TryGetProperty("value", out var valueElement) || valueElement.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<string>();
        }

        return valueElement.EnumerateArray()
            .Where(item => !item.TryGetProperty("isFolder", out var isFolderElement) || !isFolderElement.GetBoolean())
            .Select(item => item.TryGetProperty("path", out var pathElement) ? pathElement.GetString() : null)
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Cast<string>()
            .ToArray();
    }

    private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        _logger.LogInformation("Calling SCM API {Method} {Path}.", request.Method, request.RequestUri);
        var client = _httpClientFactory.CreateClient("ScmApi");
        return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
    }

    private HttpRequestMessage CreateRequest(HttpMethod method, string relativePath)
    {
        var request = new HttpRequestMessage(method, relativePath);
        request.Headers.Authorization = BasicAuthenticationHeaderFactory.Create(string.Empty, _options.Value.ReadToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return request;
    }

    private HttpRequestMessage CreateWriteRequest(HttpMethod method, string relativePath, string jsonBody)
    {
        if (string.IsNullOrWhiteSpace(_options.Value.WriteToken))
        {
            throw new InvalidOperationException("SCM write token is not configured.");
        }

        var request = new HttpRequestMessage(method, relativePath);
        request.Headers.Authorization = BasicAuthenticationHeaderFactory.Create(string.Empty, _options.Value.WriteToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
        return request;
    }

    private static void EnsureProviderSupported(RepositoryTarget target)
    {
        if (!target.Provider.Equals("AzureDevOps", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"Repository provider '{target.Provider}' is not supported in iteration 1.");
        }
    }

    private static string BuildPullRequestPath(RepositoryTarget repository, int pullRequestId)
        => $"{BuildRepositoryBasePath(repository)}/pullRequests/{pullRequestId}?api-version=7.1";

    private static string BuildRepositoryBasePath(RepositoryTarget repository)
        => $"{Uri.EscapeDataString(repository.Organization)}/{Uri.EscapeDataString(repository.Project)}/_apis/git/repositories/{Uri.EscapeDataString(repository.RepositoryName)}";

    private static string BuildDiffPath(
        RepositoryTarget target,
        string baseVersion,
        string baseVersionType,
        string targetVersion,
        string targetVersionType,
        int top,
        int skip)
        => $"{BuildRepositoryBasePath(target)}/diffs/commits?baseVersion={Uri.EscapeDataString(baseVersion)}" +
           $"&baseVersionType={Uri.EscapeDataString(baseVersionType)}" +
           $"&targetVersion={Uri.EscapeDataString(targetVersion)}" +
           $"&targetVersionType={Uri.EscapeDataString(targetVersionType)}" +
           $"&$top={top}&$skip={skip}&api-version=7.1";

    private static string BuildRefsPath(RepositoryTarget target, string branchName)
        => $"{BuildRepositoryBasePath(target)}/refs?filter={Uri.EscapeDataString($"heads/{NormalizeBranchName(branchName)}")}&api-version=7.1";

    private static string BuildPushesPath(RepositoryTarget target)
        => $"{BuildRepositoryBasePath(target)}/pushes?api-version=7.1";

    private static string BuildPullRequestsCreatePath(RepositoryTarget target)
        => $"{BuildRepositoryBasePath(target)}/pullrequests?api-version=7.1";

    private static string NormalizeRefName(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        return value.StartsWith("refs/heads/", StringComparison.OrdinalIgnoreCase)
            ? value["refs/heads/".Length..]
            : value;
    }

    private static string NormalizeBranchName(string value)
        => NormalizeRefName(value).Trim();

    private static RepositoryChangeKind MapChangeKind(string? value)
        => value?.ToLowerInvariant() switch
        {
            "add" => RepositoryChangeKind.Added,
            "delete" => RepositoryChangeKind.Deleted,
            "rename" => RepositoryChangeKind.Renamed,
            _ => RepositoryChangeKind.Modified,
        };

    private static bool IsFolderItem(JsonElement item)
        => item.TryGetProperty("isFolder", out var isFolderElement) && isFolderElement.GetBoolean();

    private static bool HasRemainingFileChanges(IReadOnlyList<JsonElement> changes, int startIndex)
    {
        for (var index = startIndex; index < changes.Count; index++)
        {
            var item = changes[index].GetProperty("item");
            var pathValue = item.TryGetProperty("path", out var pathElement)
                ? pathElement.GetString()
                : null;
            if (!string.IsNullOrWhiteSpace(pathValue) && !IsFolderItem(item))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsTextFile(string path)
        => TextExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);

    private static bool IsTestFile(string path)
        => path.Contains("/test", StringComparison.OrdinalIgnoreCase) ||
           path.Contains("/tests", StringComparison.OrdinalIgnoreCase) ||
           path.Contains("\\test", StringComparison.OrdinalIgnoreCase) ||
           path.Contains("\\tests", StringComparison.OrdinalIgnoreCase) ||
           path.Contains(".spec.", StringComparison.OrdinalIgnoreCase) ||
           path.Contains(".test.", StringComparison.OrdinalIgnoreCase) ||
           path.EndsWith("Tests.cs", StringComparison.OrdinalIgnoreCase);

    private static IReadOnlyList<string> BuildCandidateSearchRoots(
        IReadOnlyList<RepositoryFileChange> fileChanges,
        RepositoryConventions conventions)
    {
        var roots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var change in fileChanges)
        {
            var normalizedPath = NormalizePath(change.Path);
            var directory = GetDirectoryPath(normalizedPath);
            if (string.IsNullOrWhiteSpace(directory))
            {
                continue;
            }

            roots.Add(directory);

            var srcPrefix = "/src/";
            var srcIndex = directory.IndexOf(srcPrefix, StringComparison.OrdinalIgnoreCase);
            if (srcIndex >= 0)
            {
                var relative = directory[(srcIndex + srcPrefix.Length)..];
                foreach (var testRoot in conventions.TestDirectoryRoots)
                {
                    roots.Add($"{NormalizePath(testRoot)}/{relative}".TrimEnd('/'));
                }

                var relativeParent = GetDirectoryPath(relative);
                if (!string.IsNullOrWhiteSpace(relativeParent))
                {
                    foreach (var testRoot in conventions.TestDirectoryRoots)
                    {
                        roots.Add($"{NormalizePath(testRoot)}/{relativeParent}".TrimEnd('/'));
                    }
                }
            }
        }

        foreach (var testRoot in conventions.TestDirectoryRoots)
        {
            roots.Add(NormalizePath(testRoot));
        }

        return roots.ToArray();
    }

    private static int ScoreNeighboringTestPath(string path, IReadOnlyList<RepositoryFileChange> fileChanges)
    {
        var normalizedPath = NormalizePath(path);
        var bestScore = int.MaxValue;
        foreach (var change in fileChanges)
        {
            var changedPath = NormalizePath(change.Path);
            var changedName = Path.GetFileNameWithoutExtension(changedPath).Replace("Tests", string.Empty, StringComparison.OrdinalIgnoreCase);
            var candidateName = Path.GetFileNameWithoutExtension(normalizedPath).Replace("Tests", string.Empty, StringComparison.OrdinalIgnoreCase);
            var score = 100;

            if (candidateName.Contains(changedName, StringComparison.OrdinalIgnoreCase) ||
                changedName.Contains(candidateName, StringComparison.OrdinalIgnoreCase))
            {
                score -= 40;
            }

            var changedDirectory = GetDirectoryPath(changedPath);
            var candidateDirectory = GetDirectoryPath(normalizedPath);
            if (string.Equals(changedDirectory, candidateDirectory, StringComparison.OrdinalIgnoreCase))
            {
                score -= 30;
            }
            else if (!string.IsNullOrWhiteSpace(changedDirectory) &&
                     !string.IsNullOrWhiteSpace(candidateDirectory) &&
                     candidateDirectory.Contains(changedDirectory, StringComparison.OrdinalIgnoreCase))
            {
                score -= 20;
            }

            if (normalizedPath.Contains("/tests/", StringComparison.OrdinalIgnoreCase) ||
                normalizedPath.Contains("/test/", StringComparison.OrdinalIgnoreCase))
            {
                score -= 10;
            }

            bestScore = Math.Min(bestScore, score);
        }

        return bestScore;
    }

    private static string BuildMatchReason(string root)
        => $"Matched from candidate search root '{root}'.";

    private static string NormalizePath(string path)
        => path.Replace('\\', '/');

    private static string GetDirectoryPath(string path)
    {
        var normalizedPath = NormalizePath(path).TrimEnd('/');
        var lastSlashIndex = normalizedPath.LastIndexOf('/');
        return lastSlashIndex <= 0
            ? string.Empty
            : normalizedPath[..lastSlashIndex];
    }

    private static string TrimContentLines(string content, int maxLines)
    {
        var lines = content.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
        if (lines.Length <= maxLines)
        {
            return content.Trim();
        }

        return string.Join(Environment.NewLine, lines.Take(maxLines)) +
               Environment.NewLine +
               $"... truncated to {maxLines} lines";
    }

    private static string? TryGetNestedString(JsonElement parent, string propertyName, string childPropertyName)
        => parent.TryGetProperty(propertyName, out var child) &&
           child.ValueKind == JsonValueKind.Object &&
           child.TryGetProperty(childPropertyName, out var value)
            ? value.GetString()
            : null;

    private async Task<string> GetBranchObjectIdAsync(
        RepositoryTarget target,
        string branchName,
        CancellationToken ct)
    {
        using var request = CreateRequest(HttpMethod.Get, BuildRefsPath(target, branchName));
        using var response = await SendAsync(request, ct);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        var refs = document.RootElement.TryGetProperty("value", out var valueElement) &&
                   valueElement.ValueKind == JsonValueKind.Array
            ? valueElement.EnumerateArray().ToArray()
            : Array.Empty<JsonElement>();

        var expectedRefName = $"refs/heads/{NormalizeBranchName(branchName)}";
        var matchingRef = refs.FirstOrDefault(reference =>
            string.Equals(
                reference.TryGetProperty("name", out var nameElement) ? nameElement.GetString() : null,
                expectedRefName,
                StringComparison.OrdinalIgnoreCase));

        if (matchingRef.ValueKind != JsonValueKind.Object ||
            !matchingRef.TryGetProperty("objectId", out var objectIdElement) ||
            string.IsNullOrWhiteSpace(objectIdElement.GetString()))
        {
            throw new InvalidOperationException(
                $"Base branch '{branchName}' was not found for repository '{target.Alias}'.");
        }

        return objectIdElement.GetString()!;
    }

    private async Task<string> CreateBranchPushAsync(
        RepositoryTarget target,
        RepositoryWritePlan plan,
        string baseBranchHead,
        CancellationToken ct)
    {
        var payload = new
        {
            refUpdates = new[]
            {
                new
                {
                    name = $"refs/heads/{NormalizeBranchName(plan.NewBranchName)}",
                    oldObjectId = baseBranchHead,
                },
            },
            commits = new[]
            {
                new
                {
                    comment = plan.CommitMessage,
                    changes = plan.Files.Select(MapGeneratedFileChange).ToArray(),
                },
            },
        };

        using var request = CreateWriteRequest(
            HttpMethod.Post,
            BuildPushesPath(target),
            JsonSerializer.Serialize(payload));
        using var response = await SendAsync(request, ct);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        var commits = document.RootElement.TryGetProperty("commits", out var commitsElement) &&
                      commitsElement.ValueKind == JsonValueKind.Array
            ? commitsElement.EnumerateArray().ToArray()
            : Array.Empty<JsonElement>();
        string? commitId = null;
        if (commits.Length > 0 &&
            commits[0].TryGetProperty("commitId", out var commitIdElement))
        {
            commitId = commitIdElement.GetString();
        }
        if (string.IsNullOrWhiteSpace(commitId))
        {
            throw new InvalidOperationException(
                $"SCM push for repository '{target.Alias}' did not return a commit identifier.");
        }

        return commitId;
    }

    private async Task<string?> CreateDraftPullRequestAsync(
        RepositoryTarget target,
        RepositoryWritePlan plan,
        CancellationToken ct)
    {
        var payload = new
        {
            sourceRefName = $"refs/heads/{NormalizeBranchName(plan.NewBranchName)}",
            targetRefName = $"refs/heads/{NormalizeBranchName(plan.BaseBranch)}",
            title = plan.PullRequestTitle,
            description = plan.PullRequestBody,
            isDraft = true,
        };

        using var request = CreateWriteRequest(
            HttpMethod.Post,
            BuildPullRequestsCreatePath(target),
            JsonSerializer.Serialize(payload));
        using var response = await SendAsync(request, ct);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        var root = document.RootElement;

        return root.TryGetProperty("url", out var urlElement) && !string.IsNullOrWhiteSpace(urlElement.GetString())
            ? urlElement.GetString()
            : root.TryGetProperty("pullRequestId", out var pullRequestIdElement) && pullRequestIdElement.TryGetInt32(out var pullRequestId)
                ? $"{target.RepositoryUrl.TrimEnd('/')}/pullrequest/{pullRequestId}"
                : null;
    }

    private static object MapGeneratedFileChange(GeneratedFile file)
        => new
        {
            changeType = file.Action == GeneratedFileAction.Create ? "add" : "edit",
            item = new
            {
                path = file.Path,
            },
            newContent = new
            {
                content = file.Content,
                contentType = "rawtext",
            },
        };

    private sealed record DiffFetchResult(
        IReadOnlyList<RepositoryFileChange> ChangedFiles,
        IReadOnlyList<RunWarning> Warnings);

    private sealed record AggregatedChangeEntry(
        string PullRequestReference,
        int PullRequestId,
        RepositoryFileChange Change);
}
