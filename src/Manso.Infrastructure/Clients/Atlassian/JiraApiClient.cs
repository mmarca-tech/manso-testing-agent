using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Manso.Infrastructure;

public sealed class JiraApiClient : IJiraApiClient
{
    private const string DefaultTestsLinkTypeName = "Tests";
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly AtlassianDocumentTextExtractor _textExtractor;
    private readonly IOptions<JiraOptions> _options;
    private readonly ILogger<JiraApiClient> _logger;
    private JiraIssueLinkType? _cachedTestsIssueLinkType;

    public JiraApiClient(
        IHttpClientFactory httpClientFactory,
        AtlassianDocumentTextExtractor textExtractor,
        IOptions<JiraOptions> options,
        ILogger<JiraApiClient> logger)
    {
        _httpClientFactory = httpClientFactory;
        _textExtractor = textExtractor;
        _options = options;
        _logger = logger;
    }

    public async Task<JiraIssueContext> GetIssueContextAsync(
        string issueKey,
        bool includeComments,
        int maxComments,
        CancellationToken ct)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            $"rest/api/3/issue/{Uri.EscapeDataString(issueKey)}?fields=summary,description,issuetype,labels,priority,comment,issuelinks");
        request.Headers.Authorization = BasicAuthenticationHeaderFactory.Create(_options.Value.UserEmail, _options.Value.ApiToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        _logger.LogInformation("Calling Jira API GET {Path} for issue {IssueKey}.", request.RequestUri, issueKey);

        var client = _httpClientFactory.CreateClient("JiraApi");
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            throw new InvalidOperationException($"Jira issue '{issueKey}' was not found.");
        }

        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            throw new InvalidOperationException($"Jira request for issue '{issueKey}' was rejected with status {(int)response.StatusCode}.");
        }

        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: ct);

        var root = document.RootElement;
        var fields = root.GetProperty("fields");
        var comments = includeComments
            ? MapComments(fields, maxComments)
            : Array.Empty<JiraCommentContext>();
        var issueId = root.TryGetProperty("id", out var idElement) ? idElement.GetString() : null;
        var developmentRepositories = await TryGetDevelopmentRepositoriesAsync(
            issueId,
            ct);

        return new JiraIssueContext(
            root.GetProperty("key").GetString() ?? issueKey,
            fields.GetProperty("summary").GetString() ?? string.Empty,
            ExtractJiraBody(fields, "description"),
            null,
            fields.GetProperty("issuetype").GetProperty("name").GetString() ?? string.Empty,
            TryGetString(fields, "priority", "name"),
            comments,
            MapLinkedIssues(fields),
            MapLinkedIssueKeys(fields),
            MapStrings(fields, "labels"),
            developmentRepositories);
    }

    public async Task EnsureTestCoverageLinkAsync(
        string requirementIssueKey,
        string testIssueKey,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(requirementIssueKey))
        {
            throw new ArgumentException("Requirement issue key is required.", nameof(requirementIssueKey));
        }

        if (string.IsNullOrWhiteSpace(testIssueKey))
        {
            throw new ArgumentException("Test issue key is required.", nameof(testIssueKey));
        }

        var linkType = await GetTestsIssueLinkTypeAsync(ct);
        var payload = JsonSerializer.Serialize(new
        {
            type = new
            {
                id = linkType.Id,
                name = linkType.Name,
            },
            inwardIssue = new
            {
                key = requirementIssueKey,
            },
            outwardIssue = new
            {
                key = testIssueKey,
            },
        });

        using var request = new HttpRequestMessage(HttpMethod.Post, "rest/api/3/issueLink");
        request.Headers.Authorization = BasicAuthenticationHeaderFactory.Create(_options.Value.UserEmail, _options.Value.ApiToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Content = new StringContent(payload, Encoding.UTF8, "application/json");

        _logger.LogInformation(
            "Calling Jira API POST {Path} to link test {TestIssueKey} to requirement {RequirementIssueKey} using link type {LinkTypeName}.",
            request.RequestUri,
            testIssueKey,
            requirementIssueKey,
            linkType.Name);

        var client = _httpClientFactory.CreateClient("JiraApi");
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (response.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.Conflict)
        {
            var responseBody = await response.Content.ReadAsStringAsync(ct);
            if (responseBody.Contains("already linked", StringComparison.OrdinalIgnoreCase))
            {
                _logger.LogInformation(
                    "Jira issues {RequirementIssueKey} and {TestIssueKey} were already linked with link type {LinkTypeName}.",
                    requirementIssueKey,
                    testIssueKey,
                    linkType.Name);
                return;
            }
        }

        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            throw new InvalidOperationException(
                $"Jira request to link test '{testIssueKey}' to issue '{requirementIssueKey}' was rejected with status {(int)response.StatusCode}.");
        }

        response.EnsureSuccessStatusCode();
    }

    private string ExtractJiraBody(JsonElement fields, string propertyName)
    {
        if (!fields.TryGetProperty(propertyName, out var bodyElement))
        {
            return string.Empty;
        }

        return _textExtractor.ExtractJiraText(bodyElement);
    }

    private IReadOnlyList<JiraCommentContext> MapComments(JsonElement fields, int maxComments)
    {
        if (!fields.TryGetProperty("comment", out var commentElement) ||
            !commentElement.TryGetProperty("comments", out var commentsElement) ||
            commentsElement.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<JiraCommentContext>();
        }

        return commentsElement.EnumerateArray()
            .Select(comment => new JiraCommentContext(
                comment.GetProperty("id").GetString() ?? string.Empty,
                TryGetString(comment, "author", "displayName"),
                comment.TryGetProperty("body", out var bodyElement)
                    ? _textExtractor.ExtractJiraText(bodyElement)
                    : string.Empty,
                TryGetDateTimeOffset(comment, "created")))
            .Where(comment => !string.IsNullOrWhiteSpace(comment.Body))
            .OrderByDescending(comment => comment.CreatedAtUtc)
            .Take(maxComments)
            .ToArray();
    }

    private static IReadOnlyList<JiraLinkedIssue> MapLinkedIssues(JsonElement fields)
    {
        if (!fields.TryGetProperty("issuelinks", out var linksElement) || linksElement.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<JiraLinkedIssue>();
        }

        var linkedIssues = new List<JiraLinkedIssue>();
        foreach (var link in linksElement.EnumerateArray())
        {
            var linkTypeName = TryGetNestedString(link, out var parsedLinkTypeName, "type", "name")
                ? parsedLinkTypeName
                : null;

            if (TryGetNestedElement(link, out var inwardIssueElement, "inwardIssue"))
            {
                var inwardIssue = MapLinkedIssue(inwardIssueElement, linkTypeName, "inward");
                if (inwardIssue is not null)
                {
                    linkedIssues.Add(inwardIssue);
                }
            }

            if (TryGetNestedElement(link, out var outwardIssueElement, "outwardIssue"))
            {
                var outwardIssue = MapLinkedIssue(outwardIssueElement, linkTypeName, "outward");
                if (outwardIssue is not null)
                {
                    linkedIssues.Add(outwardIssue);
                }
            }
        }

        return linkedIssues
            .GroupBy(issue => issue.IssueKey, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .ToArray();
    }

    private static IReadOnlyList<string> MapLinkedIssueKeys(JsonElement fields)
        => MapLinkedIssues(fields)
            .Select(issue => issue.IssueKey)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

    private static IReadOnlyList<string> MapStrings(JsonElement parent, string propertyName)
    {
        if (!parent.TryGetProperty(propertyName, out var values) || values.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<string>();
        }

        return values.EnumerateArray()
            .Select(value => value.GetString())
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Cast<string>()
            .ToArray();
    }

    private static string? TryGetString(JsonElement parent, string propertyName, string childPropertyName)
        => parent.TryGetProperty(propertyName, out var child)
            && child.ValueKind == JsonValueKind.Object
            && child.TryGetProperty(childPropertyName, out var value)
            ? value.GetString()
            : null;

    private static bool TryGetNestedString(JsonElement parent, out string value, params string[] path)
    {
        var current = parent;
        foreach (var segment in path)
        {
            if (!current.TryGetProperty(segment, out current))
            {
                value = string.Empty;
                return false;
            }
        }

        value = current.GetString() ?? string.Empty;
        return !string.IsNullOrWhiteSpace(value);
    }

    private static bool TryGetNestedElement(JsonElement parent, out JsonElement current, params string[] path)
    {
        current = parent;
        foreach (var segment in path)
        {
            if (!current.TryGetProperty(segment, out current))
            {
                return false;
            }
        }

        return true;
    }

    private static DateTimeOffset? TryGetDateTimeOffset(JsonElement parent, string propertyName)
        => parent.TryGetProperty(propertyName, out var value) &&
           DateTimeOffset.TryParse(value.GetString(), out var parsed)
            ? parsed
            : null;

    private async Task<IReadOnlyList<JiraDevelopmentRepository>> TryGetDevelopmentRepositoriesAsync(
        string? issueId,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(issueId))
        {
            return Array.Empty<JiraDevelopmentRepository>();
        }

        var issueAri = BuildIssueAri(issueId);
        if (string.IsNullOrWhiteSpace(issueAri))
        {
            _logger.LogWarning(
                "Skipping Jira developmentInformation query because Jira:CloudId is not configured. IssueId: {IssueId}",
                issueId);
            return Array.Empty<JiraDevelopmentRepository>();
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, "gateway/api/graphql");
        request.Headers.Authorization = BasicAuthenticationHeaderFactory.Create(_options.Value.UserEmail, _options.Value.ApiToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Content = new StringContent(BuildDevelopmentInfoRequest(issueAri), Encoding.UTF8, "application/json");

        _logger.LogInformation(
            "Calling Jira GraphQL developmentInformation for issueId {IssueId} using issueAri {IssueAri}.",
            issueId,
            issueAri);

        var client = _httpClientFactory.CreateClient("JiraApi");
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized)
        {
            _logger.LogWarning(
                "Jira developmentInformation request returned status {StatusCode} for issueId {IssueId}.",
                (int)response.StatusCode,
                issueId);
            return Array.Empty<JiraDevelopmentRepository>();
        }

        if (!response.IsSuccessStatusCode)
        {
            var responseBody = await response.Content.ReadAsStringAsync(ct);
            _logger.LogWarning(
                "Jira developmentInformation request returned unexpected status {StatusCode} for issueId {IssueId}. ResponseBody: {ResponseBody}",
                (int)response.StatusCode,
                issueId,
                TruncateForLog(responseBody, 1000));
            return Array.Empty<JiraDevelopmentRepository>();
        }

        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        if (document.RootElement.TryGetProperty("errors", out var errorsElement) &&
            errorsElement.ValueKind == JsonValueKind.Array &&
            errorsElement.GetArrayLength() > 0)
        {
            var graphQlErrors = ExtractGraphQlErrors(errorsElement);
            _logger.LogWarning(
                "Jira developmentInformation query returned GraphQL errors for issueId {IssueId}. GraphQlErrors: {GraphQlErrors}",
                issueId,
                graphQlErrors);
            return Array.Empty<JiraDevelopmentRepository>();
        }

        if (!document.RootElement.TryGetProperty("data", out var dataElement) ||
            !dataElement.TryGetProperty("developmentInformation", out var developmentInformationElement) ||
            developmentInformationElement.ValueKind != JsonValueKind.Object)
        {
            _logger.LogInformation(
                "Jira developmentInformation query returned no usable developmentInformation payload for issueId {IssueId}.",
                issueId);
            return Array.Empty<JiraDevelopmentRepository>();
        }

        var repositories = MapDevelopmentRepositories(developmentInformationElement);
        _logger.LogInformation(
            "Jira developmentInformation query returned {RepositoryCount} repository entries for issueId {IssueId}. RepositoryNames: {RepositoryNames}",
            repositories.Count,
            issueId,
            repositories.Select(repository => repository.Name).ToArray());
        return repositories;
    }

    private static IReadOnlyList<JiraDevelopmentRepository> MapDevelopmentRepositories(JsonElement developmentInformation)
    {
        if (!TryGetElement(
                developmentInformation,
                out var instanceTypesElement,
                "details",
                "instanceTypes") ||
            instanceTypesElement.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<JiraDevelopmentRepository>();
        }

        var repositories = new List<JiraDevelopmentRepository>();
        foreach (var instanceType in instanceTypesElement.EnumerateArray())
        {
            var repositoryEntries = instanceType.TryGetProperty("repository", out var repositoryArrayElement) &&
                                    repositoryArrayElement.ValueKind == JsonValueKind.Array
                ? repositoryArrayElement.EnumerateArray().ToArray()
                : Array.Empty<JsonElement>();

            if (instanceType.TryGetProperty("repository", out var repositoryElement) &&
                repositoryElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var repository in repositoryEntries)
                {
                    AddOrMergeRepository(repositories, repository, Array.Empty<JiraDevelopmentPullRequest>());
                }
            }

            if (instanceType.TryGetProperty("danglingPullRequests", out var danglingPullRequestsElement) &&
                danglingPullRequestsElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var danglingPullRequest in danglingPullRequestsElement.EnumerateArray())
                {
                    var repositoryName = danglingPullRequest.TryGetProperty("repositoryName", out var repositoryNameElement)
                        ? repositoryNameElement.GetString() ?? string.Empty
                        : string.Empty;

                    var repositoryUrl = danglingPullRequest.TryGetProperty("repositoryUrl", out var repositoryUrlElement)
                        ? repositoryUrlElement.GetString()
                        : null;

                    if (string.IsNullOrWhiteSpace(repositoryName) && repositoryEntries.Length == 1)
                    {
                        repositoryName = repositoryEntries[0].TryGetProperty("name", out var fallbackNameElement)
                            ? fallbackNameElement.GetString() ?? string.Empty
                            : string.Empty;
                        repositoryUrl = repositoryEntries[0].TryGetProperty("url", out var fallbackUrlElement)
                            ? fallbackUrlElement.GetString()
                            : repositoryUrl;
                    }

                    if (string.IsNullOrWhiteSpace(repositoryName))
                    {
                        continue;
                    }

                    AddOrMergeRepository(
                        repositories,
                        repositoryName,
                        repositoryUrl,
                        Array.Empty<JiraDevelopmentBranch>(),
                        [MapPullRequest(danglingPullRequest)]);
                }
            }
        }

        return repositories;
    }

    private static void AddOrMergeRepository(
        List<JiraDevelopmentRepository> repositories,
        JsonElement repositoryElement,
        IReadOnlyList<JiraDevelopmentPullRequest> additionalPullRequests)
    {
        var name = repositoryElement.TryGetProperty("name", out var nameElement)
            ? nameElement.GetString() ?? string.Empty
            : string.Empty;
        if (string.IsNullOrWhiteSpace(name))
        {
            return;
        }

        var url = repositoryElement.TryGetProperty("url", out var urlElement)
            ? urlElement.GetString()
            : null;
        AddOrMergeRepository(
            repositories,
            name,
            url,
            MapBranches(repositoryElement),
            MapPullRequests(repositoryElement).Concat(additionalPullRequests).ToArray());
    }

    private static void AddOrMergeRepository(
        List<JiraDevelopmentRepository> repositories,
        string name,
        string? url,
        IReadOnlyList<JiraDevelopmentBranch> branches,
        IReadOnlyList<JiraDevelopmentPullRequest> pullRequests)
    {
        var existingIndex = repositories.FindIndex(repository =>
            RepositoryMatches(repository.Name, repository.Url, name, url));
        if (existingIndex < 0)
        {
            repositories.Add(new JiraDevelopmentRepository(name, url, branches, pullRequests));
            return;
        }

        var existing = repositories[existingIndex];
        repositories[existingIndex] = existing with
        {
            Url = existing.Url ?? url,
            Branches = existing.Branches
                .Concat(branches)
                .DistinctBy(branch => $"{branch.Name}|{branch.Url}|{branch.CreatePullRequestUrl}", StringComparer.OrdinalIgnoreCase)
                .ToArray(),
            PullRequests = existing.PullRequests
                .Concat(pullRequests)
                .DistinctBy(pullRequest => pullRequest.Url, StringComparer.OrdinalIgnoreCase)
                .ToArray(),
        };
    }

    private static IReadOnlyList<JiraDevelopmentBranch> MapBranches(JsonElement repositoryElement)
    {
        if (!repositoryElement.TryGetProperty("branches", out var branchesElement) ||
            branchesElement.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<JiraDevelopmentBranch>();
        }

        return branchesElement.EnumerateArray()
            .Select(branch => new JiraDevelopmentBranch(
                branch.TryGetProperty("name", out var nameElement) ? nameElement.GetString() ?? string.Empty : string.Empty,
                branch.TryGetProperty("url", out var urlElement) ? urlElement.GetString() : null,
                branch.TryGetProperty("createPullRequestUrl", out var createPullRequestUrlElement)
                    ? createPullRequestUrlElement.GetString()
                    : null))
            .Where(branch => !string.IsNullOrWhiteSpace(branch.Name))
            .ToArray();
    }

    private static IReadOnlyList<JiraDevelopmentPullRequest> MapPullRequests(JsonElement repositoryElement)
    {
        if (!repositoryElement.TryGetProperty("pullRequests", out var pullRequestsElement) ||
            pullRequestsElement.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<JiraDevelopmentPullRequest>();
        }

        return pullRequestsElement.EnumerateArray()
            .Select(MapPullRequest)
            .Where(pullRequest => !string.IsNullOrWhiteSpace(pullRequest.Url))
            .ToArray();
    }

    private static JiraDevelopmentPullRequest MapPullRequest(JsonElement pullRequest)
        => new(
            pullRequest.TryGetProperty("url", out var urlElement) ? urlElement.GetString() ?? string.Empty : string.Empty,
            pullRequest.TryGetProperty("status", out var statusElement) ? statusElement.GetString() : null,
            pullRequest.TryGetProperty("branchName", out var branchNameElement) ? branchNameElement.GetString() : null,
            pullRequest.TryGetProperty("destinationBranchName", out var destinationBranchNameElement)
                ? destinationBranchNameElement.GetString()
                : null,
            TryGetDateTimeOffset(pullRequest, "lastUpdate"));

    private static bool TryGetElement(JsonElement parent, out JsonElement current, params string[] path)
    {
        current = parent;
        foreach (var segment in path)
        {
            if (!current.TryGetProperty(segment, out current))
            {
                return false;
            }
        }

        return true;
    }

    private static string BuildDevelopmentInfoRequest(string issueId)
    {
        var payload = new
        {
            operationName = "DevDetailsDialog",
            query =
                "query DevDetailsDialog($issueId: ID!) { developmentInformation(issueId: $issueId) { details { instanceTypes { id name type typeName isSingleInstance baseUrl devStatusErrorMessages repository { name avatarUrl description url parent { name url } branches { name url createReviewUrl createPullRequestUrl lastCommit { url displayId timestamp } pullRequests { name url status lastUpdate } reviews { state url id } } commits { id displayId url createReviewUrl timestamp isMerge message author { name avatarUrl } files { linesAdded linesRemoved changeType url path } reviews { id url state } } pullRequests { id url name branchName branchUrl lastUpdate status author { name avatarUrl } reviewers { name avatarUrl isApproved } } } danglingPullRequests { id url name branchName branchUrl lastUpdate status author { name avatarUrl } reviewers { name avatarUrl isApproved } } buildProviders { id name url description avatarUrl builds { id buildNumber name description url state testSummary { totalNumber numberPassed numberFailed numberSkipped } lastUpdated references { name uri } } } } deploymentProviders { id name homeUrl logoUrl deployments { displayName url state lastUpdated pipelineId pipelineDisplayName pipelineUrl environment { id type displayName } } } featureFlagProviders { id createFlagTemplateUrl linkFlagTemplateUrl featureFlags { id key displayName providerId details { url lastUpdated environment { name type } status { enabled defaultValue rollout { percentage text rules } } } } } remoteLinksByType { providers { id name homeUrl logoUrl documentationUrl actions { id label { value } templateUrl } } types { type remoteLinks { id providerId displayName url type description status { appearance label } actionIds attributeMap { key value } } } } embeddedMarketplace { shouldDisplayForBuilds shouldDisplayForDeployments shouldDisplayForFeatureFlags } } } }",
            variables = new
            {
                issueId,
            },
        };

        return JsonSerializer.Serialize(payload);
    }

    private static bool RepositoryMatches(string existingName, string? existingUrl, string candidateName, string? candidateUrl)
    {
        if (!string.IsNullOrWhiteSpace(existingUrl) &&
            !string.IsNullOrWhiteSpace(candidateUrl) &&
            existingUrl.Equals(candidateUrl, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (existingName.Equals(candidateName, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return existingName.EndsWith($"/{candidateName}", StringComparison.OrdinalIgnoreCase) ||
               candidateName.EndsWith($"/{existingName}", StringComparison.OrdinalIgnoreCase);
    }

    private async Task<JiraIssueLinkType> GetTestsIssueLinkTypeAsync(CancellationToken ct)
    {
        if (_cachedTestsIssueLinkType is not null)
        {
            return _cachedTestsIssueLinkType;
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, "rest/api/3/issueLinkType");
        request.Headers.Authorization = BasicAuthenticationHeaderFactory.Create(_options.Value.UserEmail, _options.Value.ApiToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        _logger.LogInformation("Calling Jira API GET {Path} to resolve the issue link type used for test coverage.", request.RequestUri);

        var client = _httpClientFactory.CreateClient("JiraApi");
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            throw new InvalidOperationException($"Jira issue-link-type request was rejected with status {(int)response.StatusCode}.");
        }

        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: ct);

        if (!document.RootElement.TryGetProperty("issueLinkTypes", out var linkTypesElement) ||
            linkTypesElement.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidOperationException("Jira issue-link-type response did not include any issueLinkTypes.");
        }

        _cachedTestsIssueLinkType = linkTypesElement
            .EnumerateArray()
            .Select(element => new JiraIssueLinkType(
                element.TryGetProperty("id", out var idElement) ? idElement.GetString() ?? string.Empty : string.Empty,
                element.TryGetProperty("name", out var nameElement) ? nameElement.GetString() ?? string.Empty : string.Empty,
                element.TryGetProperty("inward", out var inwardElement) ? inwardElement.GetString() ?? string.Empty : string.Empty,
                element.TryGetProperty("outward", out var outwardElement) ? outwardElement.GetString() ?? string.Empty : string.Empty))
            .FirstOrDefault(IsTestsIssueLinkType);

        if (_cachedTestsIssueLinkType is null)
        {
            throw new InvalidOperationException(
                $"Jira does not expose a '{DefaultTestsLinkTypeName}' issue link type or an equivalent 'tests/is tested by' link.");
        }

        return _cachedTestsIssueLinkType;
    }

    private static bool IsTestsIssueLinkType(JiraIssueLinkType linkType)
    {
        if (linkType.Name.Equals(DefaultTestsLinkTypeName, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return linkType.Outward.Equals("tests", StringComparison.OrdinalIgnoreCase) &&
               linkType.Inward.Equals("is tested by", StringComparison.OrdinalIgnoreCase);
    }

    private string? BuildIssueAri(string issueId)
    {
        if (string.IsNullOrWhiteSpace(issueId))
        {
            return null;
        }

        var cloudId = _options.Value.CloudId?.Trim();
        if (string.IsNullOrWhiteSpace(cloudId))
        {
            return null;
        }

        return $"ari:cloud:jira:{cloudId}:issue/{issueId}";
    }

    private static string[] ExtractGraphQlErrors(JsonElement errorsElement)
    {
        return errorsElement.EnumerateArray()
            .Select(error =>
            {
                var message = error.TryGetProperty("message", out var messageElement)
                    ? messageElement.GetString()
                    : null;
                var errorType = error.TryGetProperty("extensions", out var extensionsElement) &&
                                extensionsElement.ValueKind == JsonValueKind.Object &&
                                extensionsElement.TryGetProperty("errorType", out var errorTypeElement)
                    ? errorTypeElement.GetString()
                    : null;

                return string.IsNullOrWhiteSpace(errorType)
                    ? message ?? "<missing GraphQL error message>"
                    : $"{errorType}: {message ?? "<missing GraphQL error message>"}";
            })
            .Where(message => !string.IsNullOrWhiteSpace(message))
            .ToArray();
    }

    private static string TruncateForLog(string value, int maxLength)
    {
        if (string.IsNullOrEmpty(value) || value.Length <= maxLength)
        {
            return value;
        }

        return $"{value[..maxLength]}...";
    }

    private static JiraLinkedIssue? MapLinkedIssue(
        JsonElement issueElement,
        string? linkTypeName,
        string direction)
    {
        if (!issueElement.TryGetProperty("key", out var keyElement))
        {
            return null;
        }

        var issueKey = keyElement.GetString() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(issueKey))
        {
            return null;
        }

        var issueType = issueElement.TryGetProperty("fields", out var fieldsElement)
                        && fieldsElement.ValueKind == JsonValueKind.Object
                        && fieldsElement.TryGetProperty("issuetype", out var issueTypeElement)
                        && issueTypeElement.ValueKind == JsonValueKind.Object
                        && issueTypeElement.TryGetProperty("name", out var issueTypeNameElement)
            ? issueTypeNameElement.GetString() ?? string.Empty
            : string.Empty;
        var summary = issueElement.TryGetProperty("fields", out fieldsElement)
                      && fieldsElement.ValueKind == JsonValueKind.Object
                      && fieldsElement.TryGetProperty("summary", out var summaryElement)
            ? summaryElement.GetString()
            : null;

        return new JiraLinkedIssue(
            issueKey,
            issueType,
            summary,
            linkTypeName,
            direction);
    }

    private sealed record JiraIssueLinkType(
        string Id,
        string Name,
        string Inward,
        string Outward);
}
