using Manso.Application;
using Manso.Domain;
using Manso.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;

namespace Manso.UnitTests;

public sealed class RepositoryResolverTests
{
    [Fact]
    public async Task ResolveAsync_IgnoresManualPullRequestHint_AndUsesMergedJiraDevelopmentPullRequest()
    {
        var resolver = CreateResolver(new StubScmClient(
            new RepositoryPullRequest(
                882,
                "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/882",
                "feature/qa-1234",
                "main",
                "source-sha",
                "target-sha",
                "active")));

        var issue = new JiraIssueContext(
            "QA-1234",
            "Retry callback",
            "Issue description",
            null,
            "Story",
            "High",
            Array.Empty<JiraCommentContext>(),
            Array.Empty<JiraLinkedIssue>(),
            Array.Empty<string>(),
            Array.Empty<string>(),
            [
                new JiraDevelopmentRepository(
                    "SomeProject/SomeTeam/SomeRepo",
                    "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo",
                    Array.Empty<JiraDevelopmentBranch>(),
                    [
                        new JiraDevelopmentPullRequest(
                            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/882",
                            "MERGED",
                            "feature/qa-1234",
                            "refs/heads/main",
                            DateTimeOffset.Parse("2026-03-28T08:00:00Z")),
                    ]),
            ]);

        var result = await resolver.ResolveAsync(issue, CreateRequest(
            repositoryAlias: "SomeRepo",
            branchOrPrHint: "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/882"), CancellationToken.None);

        Assert.Equal("SomeRepo", result.Alias);
        Assert.Equal(882, result.PullRequestId);
        Assert.Equal("feature/qa-1234", result.BranchName);
        Assert.Equal("main", result.BaseBranch);
        Assert.Equal("jira_development_pull_request", result.ResolutionEvidence);
    }

    [Fact]
    public async Task ResolveAsync_IgnoresManualBranchHint_WhenNoMergedJiraPullRequestExists()
    {
        var resolver = CreateResolver(new StubScmClient(null));

        var exception = await Assert.ThrowsAsync<RepositoryContextUnavailableException>(() => resolver.ResolveAsync(
            CreateIssue(),
            CreateRequest(repositoryAlias: "SomeRepo", branchOrPrHint: "refs/heads/feature/qa-1234"),
            CancellationToken.None));

        Assert.Contains("returned no repositories", exception.Message);
    }

    [Fact]
    public async Task ResolveAsync_ThrowsRepositoryContextUnavailable_WhenNoDevelopmentRepositoriesExist()
    {
        var resolver = CreateResolver(new StubScmClient(null));

        var exception = await Assert.ThrowsAsync<RepositoryContextUnavailableException>(() => resolver.ResolveAsync(
            CreateIssue(),
            CreateRequest(repositoryAlias: null, branchOrPrHint: "feature/qa-1234"),
            CancellationToken.None));

        Assert.Contains("returned no repositories", exception.Message);
    }

    [Fact]
    public async Task ResolveAsync_UsesJiraDevelopmentRepository_WhenAliasIsMissing()
    {
        var resolver = CreateResolver(new StubScmClient(
            new RepositoryPullRequest(
                134025,
                "https://dev.azure.com/SomeProject/repo/_git/zde-workflow-shared-configurations/pullrequest/134025",
                "RM-15891",
                "main",
                "source-sha",
                "target-sha",
                "active")));
        var issue = new JiraIssueContext(
            "RM-15888",
            "Retry callback",
            "Issue description",
            null,
            "Story",
            "High",
            Array.Empty<JiraCommentContext>(),
            Array.Empty<JiraLinkedIssue>(),
            Array.Empty<string>(),
            Array.Empty<string>(),
            [
                new JiraDevelopmentRepository(
                    "SomeProject/repo/zde-workflow-shared-configurations",
                    "https://dev.azure.com/SomeProject/repo/_git/zde-workflow-shared-configurations",
                    Array.Empty<JiraDevelopmentBranch>(),
                    [
                        new JiraDevelopmentPullRequest(
                            "https://dev.azure.com/SomeProject/repo/_git/zde-workflow-shared-configurations/pullrequest/134025",
                            "MERGED",
                            "RM-15891",
                            "refs/heads/main",
                            DateTimeOffset.Parse("2026-03-28T08:00:00Z")),
                    ]),
            ]);

        var result = await resolver.ResolveAsync(
            issue,
            CreateRequest(repositoryAlias: null, branchOrPrHint: null),
            CancellationToken.None);

        Assert.Equal("zde-workflow-shared-configurations", result.Alias);
        Assert.Equal("risk", result.Project);
        Assert.Equal(134025, result.PullRequestId);
    }

    [Fact]
    public async Task ResolveAsync_UsesSingleJiraDevelopmentRepository_WhenAliasIsMissing()
    {
        var resolver = CreateResolver(
            new StubScmClient(
                new RepositoryPullRequest(
                    882,
                    "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/882",
                    "feature/qa-1234",
                    "main",
                    "source-sha",
                    "target-sha",
                    "active")));

        var issue = new JiraIssueContext(
            "QA-1234",
            "Retry callback",
            "Issue description",
            null,
            "Story",
            "High",
            Array.Empty<JiraCommentContext>(),
            Array.Empty<JiraLinkedIssue>(),
            Array.Empty<string>(),
            Array.Empty<string>(),
            [
                new JiraDevelopmentRepository(
                    "SomeProject/SomeTeam/SomeRepo",
                    "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo",
                    Array.Empty<JiraDevelopmentBranch>(),
                    [
                        new JiraDevelopmentPullRequest(
                            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/882",
                            "MERGED",
                            "feature/qa-1234",
                            "refs/heads/main",
                            DateTimeOffset.Parse("2026-03-28T08:00:00Z")),
                    ]),
            ]);

        var result = await resolver.ResolveAsync(
            issue,
            CreateRequest(repositoryAlias: null, branchOrPrHint: null),
            CancellationToken.None);

        Assert.Equal("SomeRepo", result.Alias);
        Assert.Equal(882, result.PullRequestId);
    }

    [Fact]
    public async Task ResolveAsync_Fails_WhenAliasIsUnknown()
    {
        var resolver = CreateResolver(new StubScmClient(null));

        var issue = new JiraIssueContext(
            "QA-1234",
            "Retry callback",
            "Issue description",
            null,
            "Story",
            "High",
            Array.Empty<JiraCommentContext>(),
            Array.Empty<JiraLinkedIssue>(),
            Array.Empty<string>(),
            Array.Empty<string>(),
            [
                new JiraDevelopmentRepository(
                    "SomeProject/SomeTeam/SomeRepo",
                    "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo",
                    Array.Empty<JiraDevelopmentBranch>(),
                    Array.Empty<JiraDevelopmentPullRequest>()),
            ]);

        await Assert.ThrowsAsync<RepositoryContextUnavailableException>(() => resolver.ResolveAsync(
            issue,
            CreateRequest(repositoryAlias: "unknown-repo", branchOrPrHint: "feature/qa-1234"),
            CancellationToken.None));
    }

    [Fact]
    public async Task ResolveAsync_ThrowsRepositoryContextUnavailable_WhenNoHintExists()
    {
        var resolver = CreateResolver(new StubScmClient(null));

        var exception = await Assert.ThrowsAsync<RepositoryContextUnavailableException>(() => resolver.ResolveAsync(
            CreateIssue(),
            CreateRequest(repositoryAlias: "SomeRepo", branchOrPrHint: null),
            CancellationToken.None));

        Assert.Contains("returned no repositories", exception.Message);
    }

    private static RepositoryResolver CreateResolver(IScmClient scmClient)
        => new(
            scmClient,
            NullLogger<RepositoryResolver>.Instance);

    private static JiraIssueContext CreateIssue()
        => new(
            "QA-1234",
            "Retry callback",
            "Issue description",
            null,
            "Story",
            "High",
            Array.Empty<JiraCommentContext>(),
            Array.Empty<JiraLinkedIssue>(),
            Array.Empty<string>(),
            Array.Empty<string>(),
            Array.Empty<JiraDevelopmentRepository>());

    [Fact]
    public async Task ResolveAsync_UsesUniqueJiraDevelopmentPullRequest_WhenManualHintIsMissing()
    {
        var resolver = CreateResolver(new StubScmClient(
            new RepositoryPullRequest(
                134398,
                "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/134398",
                "feature/itsm-44766",
                "main",
                "source-sha",
                "target-sha",
                "active")));

        var issue = new JiraIssueContext(
            "ITSM-44766",
            "Retry callback",
            "Issue description",
            null,
            "Story",
            "High",
            Array.Empty<JiraCommentContext>(),
            Array.Empty<JiraLinkedIssue>(),
            Array.Empty<string>(),
            Array.Empty<string>(),
            [
                new JiraDevelopmentRepository(
                    "SomeProject/SomeTeam/SomeRepo",
                    "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo",
                    Array.Empty<JiraDevelopmentBranch>(),
                    [
                        new JiraDevelopmentPullRequest(
                            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/134398",
                            "MERGED",
                            "feature/itsm-44766",
                            "refs/heads/main",
                            DateTimeOffset.Parse("2026-03-28T08:00:00Z")),
                    ]),
            ]);

        var result = await resolver.ResolveAsync(issue, CreateRequest(
            repositoryAlias: "SomeRepo",
            branchOrPrHint: null), CancellationToken.None);

        Assert.Equal(134398, result.PullRequestId);
        Assert.Equal("jira_development_pull_request", result.ResolutionEvidence);
    }

    [Fact]
    public async Task ResolveAsync_IgnoresDeclinedJiraDevelopmentPullRequests_AndDoesNotFallbackToJiraBranch()
    {
        var resolver = CreateResolver(new StubScmClient(null));
        var issue = new JiraIssueContext(
            "RM-15888",
            "Retry callback",
            "Issue description",
            null,
            "Story",
            "High",
            Array.Empty<JiraCommentContext>(),
            Array.Empty<JiraLinkedIssue>(),
            Array.Empty<string>(),
            Array.Empty<string>(),
            [
                new JiraDevelopmentRepository(
                    "SomeProject/SomeTeam/SomeRepo",
                    "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo",
                    [
                        new JiraDevelopmentBranch(
                            "feature/rm-15888-shadow-mode",
                            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo?version=GBfeature/rm-15888-shadow-mode",
                            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequestcreate"),
                    ],
                    [
                        new JiraDevelopmentPullRequest(
                            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/134398",
                            "DECLINED",
                            "feature/rm-15888-shadow-mode",
                            "refs/heads/main",
                            DateTimeOffset.Parse("2026-03-28T08:00:00Z")),
                    ]),
            ]);

        var exception = await Assert.ThrowsAsync<RepositoryContextUnavailableException>(() => resolver.ResolveAsync(
            issue,
            CreateRequest(repositoryAlias: "SomeRepo", branchOrPrHint: null),
            CancellationToken.None));

        Assert.Contains("no usable Jira development pull requests were present", exception.Message);
    }

    [Fact]
    public async Task ResolveAsync_UsesOpenJiraDevelopmentPullRequests_ForScenarioDesign()
    {
        var resolver = CreateResolver(new StubScmClient(
            new RepositoryPullRequest(
                134398,
                "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/134398",
                "feature/rm-15888-shadow-mode",
                "main",
                "source-sha",
                "target-sha",
                "active")));
        var issue = new JiraIssueContext(
            "RM-15888",
            "Retry callback",
            "Issue description",
            null,
            "Story",
            "High",
            Array.Empty<JiraCommentContext>(),
            Array.Empty<JiraLinkedIssue>(),
            Array.Empty<string>(),
            Array.Empty<string>(),
            [
                new JiraDevelopmentRepository(
                    "SomeProject/SomeTeam/SomeRepo",
                    "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo",
                    Array.Empty<JiraDevelopmentBranch>(),
                    [
                        new JiraDevelopmentPullRequest(
                            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/134398",
                            "OPEN",
                            "feature/rm-15888-shadow-mode",
                            "refs/heads/main",
                            DateTimeOffset.Parse("2026-03-28T08:00:00Z")),
                    ]),
            ]);

        var result = await resolver.ResolveAsync(
            issue,
            CreateRequest(repositoryAlias: "SomeRepo", branchOrPrHint: null),
            CancellationToken.None);

        Assert.Equal(134398, result.PullRequestId);
        Assert.Equal("feature/rm-15888-shadow-mode", result.BranchName);
        Assert.Equal("jira_development_pull_request", result.ResolutionEvidence);
    }

    [Fact]
    public async Task ResolveAsync_ThrowsRepositoryContextUnavailable_WhenJiraDevelopmentRepositoriesDoNotMatchConfiguredRepository()
    {
        var resolver = CreateResolver(new StubScmClient(null));
        var issue = new JiraIssueContext(
            "RM-15888",
            "Retry callback",
            "Issue description",
            null,
            "Story",
            "High",
            Array.Empty<JiraCommentContext>(),
            Array.Empty<JiraLinkedIssue>(),
            Array.Empty<string>(),
            Array.Empty<string>(),
            [
                new JiraDevelopmentRepository(
                    "SomeProject/repo/zde-workflow-shared-configurations",
                    "https://dev.azure.com/SomeProject/repo/_git/zde-workflow-shared-configurations",
                    Array.Empty<JiraDevelopmentBranch>(),
                    [
                        new JiraDevelopmentPullRequest(
                            "https://dev.azure.com/SomeProject/repo/_git/zde-workflow-shared-configurations/pullrequest/134025",
                            "MERGED",
                            "RM-15891",
                            "refs/heads/main",
                            DateTimeOffset.Parse("2026-03-28T08:00:00Z")),
                    ]),
            ]);

        var exception = await Assert.ThrowsAsync<RepositoryContextUnavailableException>(() => resolver.ResolveAsync(
            issue,
            CreateRequest(repositoryAlias: "SomeRepo", branchOrPrHint: null),
            CancellationToken.None));

        Assert.Contains("only referenced different repositories", exception.Message);
        Assert.Contains("zde-workflow-shared-configurations", exception.Message);
    }

    [Fact]
    public async Task ResolveAsync_ThrowsRepositoryContextUnavailable_WhenMatchingRepositoryHasNoPullRequestsOrBranches()
    {
        var resolver = CreateResolver(new StubScmClient(null));
        var issue = new JiraIssueContext(
            "RM-15888",
            "Retry callback",
            "Issue description",
            null,
            "Story",
            "High",
            Array.Empty<JiraCommentContext>(),
            Array.Empty<JiraLinkedIssue>(),
            Array.Empty<string>(),
            Array.Empty<string>(),
            [
                new JiraDevelopmentRepository(
                    "SomeProject/SomeTeam/SomeRepo",
                    "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo",
                    Array.Empty<JiraDevelopmentBranch>(),
                    Array.Empty<JiraDevelopmentPullRequest>()),
            ]);

        var exception = await Assert.ThrowsAsync<RepositoryContextUnavailableException>(() => resolver.ResolveAsync(
            issue,
            CreateRequest(repositoryAlias: "SomeRepo", branchOrPrHint: null),
            CancellationToken.None));

        Assert.Contains("matched it, but no usable Jira development pull requests were present", exception.Message);
    }

    [Fact]
    public async Task ResolveAsync_AggregatesMergedPullRequests_ForScenarioDesign_WhenMultipleMergedPullRequestsExist()
    {
        var resolver = CreateResolver(new StubScmClient(null));

        var issue = new JiraIssueContext(
            "RM-15888",
            "Retry callback",
            "Issue description",
            null,
            "Story",
            "High",
            Array.Empty<JiraCommentContext>(),
            Array.Empty<JiraLinkedIssue>(),
            Array.Empty<string>(),
            Array.Empty<string>(),
            [
                new JiraDevelopmentRepository(
                    "SomeProject/SomeTeam/SomeRepo",
                    "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo",
                    Array.Empty<JiraDevelopmentBranch>(),
                    [
                        new JiraDevelopmentPullRequest(
                            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/134398",
                            "MERGED",
                            "feature/rm-15888-1",
                            "refs/heads/main",
                            DateTimeOffset.Parse("2026-03-27T08:00:00Z")),
                        new JiraDevelopmentPullRequest(
                            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/134399",
                            "MERGED",
                            "feature/rm-15888-2",
                            "refs/heads/main",
                            DateTimeOffset.Parse("2026-03-28T08:00:00Z")),
                    ]),
            ]);

        var result = await resolver.ResolveAsync(
            issue,
            CreateRequest("SomeRepo", null, WorkflowPass.ScenarioDesign),
            CancellationToken.None);

        Assert.Null(result.PullRequestId);
        Assert.Null(result.PullRequestReference);
        Assert.Equal("jira_development_pull_request_aggregate", result.ResolutionEvidence);
        Assert.Equal([134398, 134399], result.PullRequestIds);
        Assert.Equal(
            [
                "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/134398",
                "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/134399",
            ],
            result.PullRequestReferences);
    }

    private static NormalizedRunRequest CreateRequest(
        string? repositoryAlias,
        string? branchOrPrHint,
        WorkflowPass workflowPass = WorkflowPass.ScenarioDesign)
        => new(
            "QA-1234",
            workflowPass,
            TestScope.Api,
            repositoryAlias,
            "abc");

    private sealed class StubScmClient : IScmClient
    {
        private readonly RepositoryPullRequest? _pullRequest;

        public StubScmClient(RepositoryPullRequest? pullRequest)
        {
            _pullRequest = pullRequest;
        }

        public Task<RepositoryPullRequest> GetPullRequestAsync(
            RepositoryTarget repository,
            int pullRequestId,
            CancellationToken ct)
        {
            if (_pullRequest is null)
            {
                throw new InvalidOperationException("No pull request was configured for this test.");
            }

            return Task.FromResult(_pullRequest);
        }

        public Task<RepositoryContextBundle> GetCodeContextAsync(
            RepositoryTarget target,
            RepositoryRetrievalOptions options,
            RepositoryConventions conventions,
            CancellationToken ct)
            => throw new NotSupportedException();

        public Task<IReadOnlyList<RepositoryGuidanceFile>> GetRepositoryFilesAsync(
            RepositoryTarget target,
            IReadOnlyList<string> paths,
            CancellationToken ct)
            => throw new NotSupportedException();

    }
}
