using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging.Abstractions;

namespace Manso.UnitTests;

public sealed class XrayTestCaseSyncServiceTests
{
    [Fact]
    public async Task SyncAsync_UpdatesSingleConfidentMatch()
    {
        var client = new StubXrayApiClient();
        var service = new XrayTestCaseSyncService(
            client,
            new XrayRetrievalOptions
            {
                ProjectKey = "QA",
                DefaultCreatedTestType = "Cucumber",
            },
            NullLogger<XrayTestCaseSyncService>.Instance);

        var result = await service.SyncAsync(
            CreateRequest(),
            CreateIssue(),
            CreateScenarioBundle(),
            new XrayContextBundle(
                [
                    new XrayTestCase(
                        "20001",
                        "QA-T1",
                        "Retry transient callback",
                        "Cucumber",
                        "Scenario: Retry transient callback failure",
                        Array.Empty<XrayTestStep>(),
                        Array.Empty<string>())
                ],
                Array.Empty<RunWarning>()),
            CancellationToken.None);

        var item = Assert.Single(result.Items);
        Assert.Equal("Updated", item.Action);
        Assert.NotNull(client.LastUpsertRequest);
        Assert.Equal("20001", client.LastUpsertRequest!.ExistingIssueId);
        Assert.Equal("Cucumber", client.LastUpsertRequest.TestType);
    }

    [Fact]
    public async Task SyncAsync_CreatesNewTest_WhenNoMatchExists()
    {
        var client = new StubXrayApiClient();
        var service = new XrayTestCaseSyncService(
            client,
            new XrayRetrievalOptions
            {
                ProjectKey = "QA",
                DefaultCreatedTestType = "Cucumber",
            },
            NullLogger<XrayTestCaseSyncService>.Instance);

        var result = await service.SyncAsync(
            CreateRequest(),
            CreateIssue(),
            CreateScenarioBundle(),
            new XrayContextBundle(Array.Empty<XrayTestCase>(), Array.Empty<RunWarning>()),
            CancellationToken.None);

        var item = Assert.Single(result.Items);
        Assert.Equal("Created", item.Action);
        Assert.NotNull(client.LastUpsertRequest);
        Assert.Null(client.LastUpsertRequest!.ExistingIssueId);
        Assert.Equal("Cucumber", client.LastUpsertRequest.TestType);
    }

    [Fact]
    public async Task SyncAsync_WarnsOnAmbiguousMatch()
    {
        var client = new StubXrayApiClient();
        var service = new XrayTestCaseSyncService(
            client,
            new XrayRetrievalOptions
            {
                ProjectKey = "QA",
                DefaultCreatedTestType = "Cucumber",
            },
            NullLogger<XrayTestCaseSyncService>.Instance);

        var result = await service.SyncAsync(
            CreateRequest(),
            CreateIssue(),
            CreateScenarioBundle(),
            new XrayContextBundle(
                [
                    new XrayTestCase("20001", "QA-T1", "Retry transient callback", "Cucumber", null, Array.Empty<XrayTestStep>(), Array.Empty<string>()),
                    new XrayTestCase("20002", "QA-T2", "Retry transient callback", "Cucumber", null, Array.Empty<XrayTestStep>(), Array.Empty<string>()),
                ],
                Array.Empty<RunWarning>()),
            CancellationToken.None);

        var item = Assert.Single(result.Items);
        Assert.Equal("AmbiguousMatch", item.Action);
        Assert.Contains(result.Warnings, warning => warning.Code == "xray_ambiguous_match");
        Assert.Null(client.LastUpsertRequest);
    }

    [Fact]
    public async Task SyncAsync_UsesProjectPrefixFromIssueKey_ForUpsert()
    {
        var client = new StubXrayApiClient();
        var service = new XrayTestCaseSyncService(
            client,
            new XrayRetrievalOptions
            {
                ProjectKey = "QA",
                DefaultCreatedTestType = "Cucumber",
            },
            NullLogger<XrayTestCaseSyncService>.Instance);

        await service.SyncAsync(
            CreateRequest("RM-18999"),
            CreateIssue("RM-18999"),
            CreateScenarioBundle(),
            new XrayContextBundle(Array.Empty<XrayTestCase>(), Array.Empty<RunWarning>()),
            CancellationToken.None);

        Assert.NotNull(client.LastUpsertRequest);
        Assert.Equal("RM", client.LastUpsertRequest!.ProjectKey);
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
            Array.Empty<string>(),
            ["payments"],
            Array.Empty<JiraDevelopmentRepository>());

    private static GeneratedScenarioBundle CreateScenarioBundle()
        => new(
            [
                new GeneratedScenario(
                    "SCN-001",
                    "Retry transient callback",
                    "High",
                    "Api",
                    ["AC-1"],
                    "Retry behavior changed.",
                    ["Callback exists"],
                    "Scenario: Retry transient callback failure",
                    "Callback is retried successfully",
                    "No duplicate found"),
            ],
            "Mock",
            "mock-model",
            "{}");

    private sealed class StubXrayApiClient : IXrayApiClient
    {
        public XrayTestCaseUpsertRequest? LastUpsertRequest { get; private set; }

        public Task<IReadOnlyList<XrayTestCase>> SearchTestsAsync(
            XrayTestSearchRequest request,
            CancellationToken ct)
            => throw new NotSupportedException();

        public Task<XrayTestCaseUpsertResult> UpsertTestCaseAsync(
            XrayTestCaseUpsertRequest request,
            CancellationToken ct)
        {
            LastUpsertRequest = request;
            return Task.FromResult(new XrayTestCaseUpsertResult(
                request.ExistingIssueId ?? "30001",
                request.ExistingIssueId is null ? "QA-T30001" : "QA-T1",
                request.ExistingIssueId is null));
        }

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
