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
            new StubXrayApiClient(Array.Empty<XrayTestCase>()),
            new XrayRetrievalOptions { Enabled = false, ProjectKey = "QA" },
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
        [
            new XrayTestCase("20001", "QA-T1", "Retry callback", "Cucumber", "Scenario: Retry callback", Array.Empty<XrayTestStep>(), ["payments"]),
            new XrayTestCase("20001", "QA-T1", "Retry callback", "Cucumber", "Scenario: Retry callback", Array.Empty<XrayTestStep>(), ["payments"]),
        ]);
        var service = new XrayContextService(
            client,
            new XrayRetrievalOptions
            {
                Enabled = true,
                ProjectKey = "QA",
                MaxNeighboringTests = 5,
                SearchJqlTemplate = "project = {XRAY_PROJECT_KEY} AND text ~ \"\\\"{ISSUE_KEY}\\\"\" AND text ~ \"\\\"{ISSUE_SUMMARY}\\\"\"",
            },
            NullLogger<XrayContextService>.Instance);

        var result = await service.BuildAsync(
            CreateRequest(),
            CreateIssue(),
            null,
            null,
            CancellationToken.None);

        Assert.Single(result.NeighboringTests);
        Assert.NotNull(client.LastRequest);
        Assert.Contains("project = QA", client.LastRequest!.Jql);
        Assert.Contains("QA-1234", client.LastRequest.Jql);
        Assert.Contains("Retry callback", client.LastRequest.Jql);
    }

    [Fact]
    public async Task BuildAsync_UsesProjectPrefixFromIssueKey()
    {
        var client = new StubXrayApiClient(Array.Empty<XrayTestCase>());
        var service = new XrayContextService(
            client,
            new XrayRetrievalOptions
            {
                Enabled = true,
                ProjectKey = "QA",
                MaxNeighboringTests = 5,
                SearchJqlTemplate = "project = {XRAY_PROJECT_KEY} AND text ~ \"\\\"{ISSUE_KEY}\\\"\"",
            },
            NullLogger<XrayContextService>.Instance);

        await service.BuildAsync(
            CreateRequest("RM-18999"),
            CreateIssue("RM-18999"),
            null,
            null,
            CancellationToken.None);

        Assert.NotNull(client.LastRequest);
        Assert.Contains("project = RM", client.LastRequest!.Jql);
        Assert.DoesNotContain("project = QA", client.LastRequest.Jql);
    }

    private static NormalizedRunRequest CreateRequest(string issueKey = "QA-1234")
        => new(
            issueKey,
            $"https://yourcompany.atlassian.net/browse/{issueKey}",
            GenerationMode.TestCasesOnly,
            WorkflowPass.ScenarioDesign,
            TestScope.Api,
            "bank-otp-api",
            null,
            Array.Empty<string>(),
            CoverageIntent.Regression,
            OutputTarget.JiraComment,
            new RequestedBy("abc", "Manuel", "manuel@example.com"),
            DocumentationMode.ExplicitOnly);

    private static JiraIssueContext CreateIssue(string issueKey = "QA-1234")
        => new(
            issueKey,
            "Retry callback",
            "Description",
            "Acceptance criteria",
            "Story",
            "High",
            Array.Empty<JiraCommentContext>(),
            ["QA-1200"],
            ["payments"],
            Array.Empty<JiraDevelopmentRepository>());

    private sealed class StubXrayApiClient : IXrayApiClient
    {
        private readonly IReadOnlyList<XrayTestCase> _results;

        public StubXrayApiClient(IReadOnlyList<XrayTestCase> results)
        {
            _results = results;
        }

        public XrayTestSearchRequest? LastRequest { get; private set; }

        public Task<IReadOnlyList<XrayTestCase>> SearchTestsAsync(
            XrayTestSearchRequest request,
            CancellationToken ct)
        {
            LastRequest = request;
            return Task.FromResult(_results);
        }

        public Task<XrayTestCaseUpsertResult> UpsertTestCaseAsync(
            XrayTestCaseUpsertRequest request,
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
