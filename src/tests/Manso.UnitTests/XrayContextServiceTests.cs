using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging.Abstractions;

namespace Manso.UnitTests;

public sealed class XrayContextServiceTests
{
    [Fact]
    public async Task BuildAsync_ReturnsWarning_WhenDisabled()
    {
        var service = new XrayContextService(
            new StubXrayApiClient(_ => Array.Empty<XrayTestCase>()),
            new XrayRetrievalOptions { Enabled = false },
            NullLogger<XrayContextService>.Instance);

        var result = await service.BuildAsync(
            CreateRequest(),
            CreateIssue(),
            null,
            null,
            CancellationToken.None);

        Assert.Empty(result.NeighboringTests);
        Assert.Contains(result.Warnings, warning => warning.Code == "xray_lookup_disabled");
    }

    [Fact]
    public async Task BuildAsync_QueriesXrayAndDeduplicatesResults()
    {
        var client = new StubXrayApiClient(
            _ =>
            [
                new XrayTestCase("20001", "QA-T1", "Retry callback", "Cucumber", "Scenario: Retry callback", Array.Empty<XrayTestStep>(), ["payments"]),
                new XrayTestCase("20001", "QA-T1", "Retry callback", "Cucumber", "Scenario: Retry callback", Array.Empty<XrayTestStep>(), ["payments"]),
            ]);
        var service = new XrayContextService(
            client,
            new XrayRetrievalOptions
            {
                Enabled = true,
                MaxNeighboringTests = 5,
            },
            NullLogger<XrayContextService>.Instance);

        var result = await service.BuildAsync(
            CreateRequest(),
            CreateIssue(),
            null,
            null,
            CancellationToken.None);

        Assert.Single(result.NeighboringTests);
        Assert.NotEmpty(client.Requests);
        Assert.Contains(client.Requests, request => request.Jql.Contains("project = QA", StringComparison.Ordinal));
        Assert.Contains(client.Requests, request => request.Jql.Contains("QA-1234", StringComparison.Ordinal));
        Assert.Contains(client.Requests, request => request.Jql.Contains("Retry callback", StringComparison.Ordinal));
        Assert.Contains(client.Requests, request => request.Jql.Contains("issuetype in (\"Test Case\", \"Test\")", StringComparison.Ordinal));
    }

    [Fact]
    public async Task BuildAsync_UsesProjectPrefixFromIssueKey()
    {
        var client = new StubXrayApiClient(_ => Array.Empty<XrayTestCase>());
        var service = new XrayContextService(
            client,
            new XrayRetrievalOptions
            {
                Enabled = true,
                MaxNeighboringTests = 5,
            },
            NullLogger<XrayContextService>.Instance);

        await service.BuildAsync(
            CreateRequest("RM-18999"),
            CreateIssue("RM-18999"),
            null,
            null,
            CancellationToken.None);

        Assert.NotEmpty(client.Requests);
        Assert.Contains(client.Requests, request => request.Jql.Contains("project = RM", StringComparison.Ordinal));
        Assert.Contains(client.Requests, request => request.Jql.Contains("issue in linkedIssues(\"RM-18999\")", StringComparison.Ordinal));
        Assert.Contains(client.Requests, request => request.Jql.Contains("issuetype in (\"Test Case\", \"Test\")", StringComparison.Ordinal));
    }

    [Fact]
    public async Task BuildAsync_IncludesTestsAlreadyLinkedToIssue_InBundleContext()
    {
        var client = new StubXrayApiClient(request =>
            request.Jql.Contains("issue in linkedIssues(\"QA-1234\")", StringComparison.Ordinal) ||
            request.Jql.Contains("key in (\"QA-T2\")", StringComparison.Ordinal)
                ? [new XrayTestCase("20002", "QA-T2", "Manually created linked test", "Manual", null, Array.Empty<XrayTestStep>(), ["payments"])]
                : Array.Empty<XrayTestCase>());
        var service = new XrayContextService(
            client,
            new XrayRetrievalOptions
            {
                Enabled = true,
                MaxNeighboringTests = 5,
            },
            NullLogger<XrayContextService>.Instance);

        var result = await service.BuildAsync(
            CreateRequest(),
            CreateIssue(),
            null,
            null,
            CancellationToken.None);

        var test = Assert.Single(result.NeighboringTests);
        Assert.Equal("QA-T2", test.IssueKey);
        Assert.Contains(client.Requests, request => request.Jql.Contains("issue in linkedIssues(\"QA-1234\")", StringComparison.Ordinal));
    }

    [Fact]
    public async Task BuildAsync_DoesNotCapLinkedTestsToNeighborLimit()
    {
        var linkedIssues = Enumerable.Range(1, 12)
            .Select(index => new JiraLinkedIssue($"QA-T{index}", "Test", $"Test {index}", "Tests", "outward"))
            .ToArray();
        var client = new StubXrayApiClient(request =>
            request.Jql.Contains("issue in linkedIssues(\"QA-1234\")", StringComparison.Ordinal)
                ? linkedIssues.Select((issue, index) =>
                    new XrayTestCase(
                        (30000 + index).ToString(),
                        issue.IssueKey,
                        issue.Summary ?? issue.IssueKey,
                        "Manual",
                        null,
                        Array.Empty<XrayTestStep>(),
                        Array.Empty<string>()))
                    .ToArray()
                : Array.Empty<XrayTestCase>());
        var service = new XrayContextService(
            client,
            new XrayRetrievalOptions
            {
                Enabled = true,
                MaxNeighboringTests = 5,
            },
            NullLogger<XrayContextService>.Instance);

        var result = await service.BuildAsync(
            CreateRequest(),
            CreateIssue(linkedIssues: linkedIssues),
            null,
            null,
            CancellationToken.None);

        Assert.Equal(12, result.NeighboringTests.Count);
        Assert.Contains(client.Requests, request => request.Jql.Contains("issue in linkedIssues(\"QA-1234\")", StringComparison.Ordinal) && request.Limit == 12);
    }

    private static NormalizedRunRequest CreateRequest(string issueKey = "QA-1234")
        => new(
            issueKey,
            GenerationMode.TestCasesOnly,
            WorkflowPass.ScenarioDesign,
            TestScope.Api,
            "bank-otp-api",
            Array.Empty<string>(),
            CoverageIntent.Regression,
            OutputTarget.JiraComment,
            new RequestedBy("abc", "Manuel", "manuel@example.com"),
            DocumentationMode.ExplicitOnly);

    private static JiraIssueContext CreateIssue(
        string issueKey = "QA-1234",
        IReadOnlyList<JiraLinkedIssue>? linkedIssues = null)
        => new(
            issueKey,
            "Retry callback",
            "Description",
            "Acceptance criteria",
            "Story",
            "High",
            Array.Empty<JiraCommentContext>(),
            linkedIssues ?? (issueKey == "QA-1234"
                ? [new JiraLinkedIssue("QA-T2", "Test", "Manually created linked test", "Tests", "outward")]
                : Array.Empty<JiraLinkedIssue>()),
            ["QA-1200"],
            ["payments"],
            Array.Empty<JiraDevelopmentRepository>());

    private sealed class StubXrayApiClient : IXrayApiClient
    {
        private readonly Func<XrayTestSearchRequest, IReadOnlyList<XrayTestCase>> _resultsFactory;

        public StubXrayApiClient(Func<XrayTestSearchRequest, IReadOnlyList<XrayTestCase>> resultsFactory)
        {
            _resultsFactory = resultsFactory;
        }

        public List<XrayTestSearchRequest> Requests { get; } = [];

        public Task<IReadOnlyList<XrayTestCase>> SearchTestsAsync(
            XrayTestSearchRequest request,
            CancellationToken ct)
        {
            Requests.Add(request);
            return Task.FromResult(_resultsFactory(request));
        }

        public Task<XrayTestCaseUpsertResult> UpsertTestCaseAsync(
            XrayTestCaseUpsertRequest request,
            CancellationToken ct)
            => throw new NotSupportedException();

        public Task<IReadOnlyList<XrayTestSet>> SearchTestSetsAsync(
            XrayTestSetSearchRequest request,
            CancellationToken ct)
            => throw new NotSupportedException();

        public Task<XrayTestSetCreateResult> CreateTestSetAsync(
            XrayTestSetCreateRequest request,
            CancellationToken ct)
            => throw new NotSupportedException();

        public Task<XrayTestExecutionUploadResult> UploadExecutionAsync(
            XrayTestExecutionUploadRequest request,
            CancellationToken ct)
            => throw new NotSupportedException();

        public Task AddTestsToTestPlanAsync(
            XrayAssociationUpdateRequest request,
            CancellationToken ct)
            => throw new NotSupportedException();

        public Task AddTestsToTestSetAsync(
            XrayAssociationUpdateRequest request,
            CancellationToken ct)
            => throw new NotSupportedException();
    }
}
