using Manso.Application;
using Manso.Domain;

namespace Manso.IntegrationTests;

internal sealed class FakeJiraApiClient : IJiraApiClient
{
    public Task<JiraIssueContext> GetIssueContextAsync(
        string issueKey,
        bool includeComments,
        int maxComments,
        CancellationToken ct)
    {
        IReadOnlyList<JiraCommentContext> comments = includeComments
            ? new[]
            {
                new JiraCommentContext(
                    "c1",
                    "Reviewer One",
                    "Check the retry edge cases in https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/22222/Retry+Decision+Log",
                    DateTimeOffset.UtcNow),
            }.Take(maxComments).ToArray()
            : Array.Empty<JiraCommentContext>();

        var developmentRepositories = issueKey.Equals("QA-NOPR", StringComparison.OrdinalIgnoreCase)
            ? Array.Empty<JiraDevelopmentRepository>()
            : issueKey.Equals("QA-MULTIPR", StringComparison.OrdinalIgnoreCase)
            ? new[]
            {
                new JiraDevelopmentRepository(
                    "afs-dev/rps/bank-otp-api",
                    "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api",
                    Array.Empty<JiraDevelopmentBranch>(),
                    [
                        new JiraDevelopmentPullRequest(
                            "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/881",
                            "MERGED",
                            "feature/qa-multipr-1",
                            "refs/heads/main",
                            DateTimeOffset.Parse("2026-03-27T08:00:00Z")),
                        new JiraDevelopmentPullRequest(
                            "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/882",
                            "MERGED",
                            "feature/qa-multipr-2",
                            "refs/heads/main",
                            DateTimeOffset.Parse("2026-03-28T08:00:00Z")),
                    ]),
            }
            : new[]
            {
                new JiraDevelopmentRepository(
                    "afs-dev/rps/bank-otp-api",
                    "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api",
                    Array.Empty<JiraDevelopmentBranch>(),
                    [
                        new JiraDevelopmentPullRequest(
                            "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/882",
                            "MERGED",
                            "feature/qa-1234-retry-handling",
                            "refs/heads/main",
                            DateTimeOffset.Parse("2026-03-28T08:00:00Z")),
                    ]),
            };

        return Task.FromResult(new JiraIssueContext(
            issueKey,
            "Add retry handling to payment callback",
            "The callback should retry transient failures and stop on terminal failures.",
            "Retries must be idempotent.",
            "Story",
            "High",
            comments,
            [
                new JiraLinkedIssue("QA-1001", "Test", "Retries transient callback failures", "Tests", "outward"),
                new JiraLinkedIssue("QA-1002", "Test", "Does not retry terminal callback failures", "Tests", "outward"),
            ],
            ["QA-1200"],
            ["payments", "retry"],
            developmentRepositories));
    }

    public Task EnsureTestCoverageLinkAsync(
        string requirementIssueKey,
        string testIssueKey,
        CancellationToken ct)
        => Task.CompletedTask;
}

internal sealed class FakeConfluenceApiClient : IConfluenceApiClient
{
    public Task<ConfluenceDocument> GetDocumentAsync(
        string sourceUrl,
        string pageId,
        int maxChunks,
        CancellationToken ct)
    {
        var allChunks = new[]
        {
            new ConfluenceChunk($"{pageId}-1", "Overview", "This page describes callback retry behavior.", 10),
            new ConfluenceChunk($"{pageId}-2", "Contract", "HTTP 5xx responses are retried with exponential backoff.", 12),
            new ConfluenceChunk($"{pageId}-3", "Limits", "Duplicate callbacks must not create duplicate payouts.", 12),
        };

        return Task.FromResult(new ConfluenceDocument(
            sourceUrl,
            pageId,
            $"Page {pageId}",
            "ENG",
            3,
            DateTimeOffset.UtcNow,
            allChunks.Take(maxChunks).ToArray()));
    }
}

internal sealed class FakeXrayApiClient : IXrayApiClient
{
    private int _nextIssueNumber = 100;
    private int _nextTestSetNumber = 1;

    public Task<IReadOnlyList<XrayTestCase>> SearchTestsAsync(
        XrayTestSearchRequest request,
        CancellationToken ct)
        => Task.FromResult<IReadOnlyList<XrayTestCase>>(
        [
            new XrayTestCase(
                "20001",
                "QA-1001",
                "Retries transient callback failures",
                "Cucumber",
                "Scenario: Retry transient callback failure",
                Array.Empty<XrayTestStep>(),
                ["payments", "retry"]),
            new XrayTestCase(
                "20002",
                "QA-1002",
                "Does not retry terminal callback failures",
                "Manual",
                null,
                [
                    new XrayTestStep(
                        "Trigger a terminal callback failure",
                        null,
                        "The callback is not retried")
                ],
                ["payments"]),
        ]);

    public Task<IReadOnlyList<XrayTestSet>> SearchTestSetsAsync(
        XrayTestSetSearchRequest request,
        CancellationToken ct)
        => Task.FromResult<IReadOnlyList<XrayTestSet>>(
        [
            new XrayTestSet(
                "50001",
                "QA-TS1",
                "bank-otp-api - Callbacks Test Set"),
        ]);

    public Task<XrayTestCaseUpsertResult> UpsertTestCaseAsync(
        XrayTestCaseUpsertRequest request,
        CancellationToken ct)
    {
        var created = string.IsNullOrWhiteSpace(request.ExistingIssueId);
        var issueNumber = created ? Interlocked.Increment(ref _nextIssueNumber) : int.Parse(request.ExistingIssueId!, System.Globalization.CultureInfo.InvariantCulture);
        return Task.FromResult(new XrayTestCaseUpsertResult(
            issueNumber.ToString(System.Globalization.CultureInfo.InvariantCulture),
            $"QA-{issueNumber}",
            created));
    }

    public Task<XrayTestSetCreateResult> CreateTestSetAsync(
        XrayTestSetCreateRequest request,
        CancellationToken ct)
    {
        var issueNumber = Interlocked.Increment(ref _nextTestSetNumber);
        return Task.FromResult(new XrayTestSetCreateResult(
            (50000 + issueNumber).ToString(System.Globalization.CultureInfo.InvariantCulture),
            $"QA-TS{issueNumber}",
            true));
    }

    public Task<XrayTestExecutionUploadResult> UploadExecutionAsync(
        XrayTestExecutionUploadRequest request,
        CancellationToken ct)
        => throw new NotImplementedException();

    public Task AddTestsToTestPlanAsync(
        XrayAssociationUpdateRequest request,
        CancellationToken ct)
        => throw new NotImplementedException();

    public Task AddTestsToTestSetAsync(
        XrayAssociationUpdateRequest request,
        CancellationToken ct)
        => Task.CompletedTask;
}

internal sealed class FakeScmClient : IScmClient
{
    private static readonly RepositoryConventions Conventions = new(
        "bank-otp-api",
        false,
        "xUnit",
        ".NET 10",
        ["/tests", "/src/Tests"],
        ["/tests", "/src/Tests"],
        ["/src"],
        ["dotnet build src/Manso.sln"],
        ["dotnet test src/Manso.sln"],
        ["dotnet format src/Manso.sln --verify-no-changes"],
        "Tests.cs");

    public Task<RepositoryPullRequest> GetPullRequestAsync(
        RepositoryTarget repository,
        int pullRequestId,
        CancellationToken ct)
        => Task.FromResult(new RepositoryPullRequest(
            pullRequestId,
            $"{repository.RepositoryUrl.TrimEnd('/')}/pullrequest/{pullRequestId}",
            "feature/qa-1234-retry-handling",
            "main",
            "source-commit-sha",
            "target-commit-sha",
            "active"));

    public Task<RepositoryContextBundle> GetCodeContextAsync(
        RepositoryTarget target,
        RepositoryRetrievalOptions options,
        RepositoryConventions conventions,
        CancellationToken ct)
    {
        var changes = new[]
        {
            new RepositoryFileChange(
                "/src/Callbacks/RetryHandler.cs",
                RepositoryChangeKind.Modified,
                false,
                null,
                """
                --- a/src/Callbacks/RetryHandler.cs
                +++ b/src/Callbacks/RetryHandler.cs
                -return Retry.None;
                +return Retry.Exponential(maxAttempts: 3);
                """),
            new RepositoryFileChange(
                "/tests/Callbacks/RetryHandlerTests.cs",
                RepositoryChangeKind.Added,
                true,
                null,
                """
                --- a/tests/Callbacks/RetryHandlerTests.cs
                +++ b/tests/Callbacks/RetryHandlerTests.cs
                +[Fact]
                +public void Retries_transient_failures()
                """),
        };

        return Task.FromResult(new RepositoryContextBundle(
            target,
            Conventions,
            changes.Take(options.MaxChangedFiles).ToArray(),
            [
                new NeighboringTestFile(
                    "/tests/Callbacks/ExistingRetryHandlerTests.cs",
                    "Matched from candidate search root '/tests/Callbacks'.",
                    """
                    [Fact]
                    public void Does_not_retry_terminal_failures()
                    {
                        // existing pattern
                    }
                    """),
            ],
            string.Join(Environment.NewLine + Environment.NewLine, changes.Select(change => change.DiffPreview)),
            Array.Empty<RunWarning>()));
    }

    public Task<RepositoryWriteExecutionResult> WriteAsync(
        RepositoryTarget target,
        RepositoryWritePlan plan,
        CancellationToken ct)
        => Task.FromResult(new RepositoryWriteExecutionResult(
            plan.NewBranchName,
            "fake-commit-id",
            $"{target.RepositoryUrl.TrimEnd('/')}/pullrequest/999"));
}
