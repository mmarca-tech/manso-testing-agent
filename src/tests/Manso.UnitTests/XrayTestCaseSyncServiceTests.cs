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
        var jiraClient = new StubJiraApiClient();
        var service = new XrayTestCaseSyncService(
            client,
            jiraClient,
            new XrayRetrievalOptions
            {
                DefaultCreatedTestType = "Cucumber",
            },
            NullLogger<XrayTestCaseSyncService>.Instance);

        var result = await service.SyncAsync(
            CreateRequest(),
            CreateIssue(),
            CreateScenarioBundle(),
            CreateRepositoryContext(),
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
        Assert.Equal("QA-1234", jiraClient.LastRequirementIssueKey);
        Assert.Equal("QA-T1", jiraClient.LastTestIssueKey);
        Assert.Equal("40001", client.LastTestSetAssociationRequest?.ContainerIssueId);
    }

    [Fact]
    public async Task SyncAsync_UsesExplicitExistingXrayIssueKeyHint_WhenProvided()
    {
        var client = new StubXrayApiClient();
        var jiraClient = new StubJiraApiClient();
        var service = new XrayTestCaseSyncService(
            client,
            jiraClient,
            new XrayRetrievalOptions
            {
                DefaultCreatedTestType = "Cucumber",
            },
            NullLogger<XrayTestCaseSyncService>.Instance);

        var scenarios = new GeneratedScenarioBundle(
            [
                new GeneratedScenario(
                    "SCN-001",
                    "Different phrasing for retry transient callback",
                    "High",
                    "Api",
                    ["AC-1"],
                    "Retry behavior changed.",
                    ["Callback exists"],
                    "Scenario: Callback retry is applied to transient failures",
                    "Callback is retried successfully",
                    "Already covered by QA-T1.",
                    "QA-T1"),
            ],
            "Mock",
            "mock-model",
            "{}");

        var result = await service.SyncAsync(
            CreateRequest(),
            CreateIssue(),
            scenarios,
            CreateRepositoryContext(),
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

        Assert.Equal("Updated", Assert.Single(result.Items).Action);
        Assert.Equal("20001", client.LastUpsertRequest!.ExistingIssueId);
        Assert.Equal("QA-T1", jiraClient.LastTestIssueKey);
    }

    [Fact]
    public async Task SyncAsync_CreatesNewTest_WhenNoMatchExists()
    {
        var client = new StubXrayApiClient();
        var jiraClient = new StubJiraApiClient();
        var service = new XrayTestCaseSyncService(
            client,
            jiraClient,
            new XrayRetrievalOptions
            {
                DefaultCreatedTestType = "Cucumber",
            },
            NullLogger<XrayTestCaseSyncService>.Instance);

        var result = await service.SyncAsync(
            CreateRequest(),
            CreateIssue(),
            CreateScenarioBundle(),
            CreateRepositoryContext(),
            new XrayContextBundle(Array.Empty<XrayTestCase>(), Array.Empty<RunWarning>()),
            CancellationToken.None);

        var item = Assert.Single(result.Items);
        Assert.Equal("Created", item.Action);
        Assert.NotNull(client.LastUpsertRequest);
        Assert.Null(client.LastUpsertRequest!.ExistingIssueId);
        Assert.Equal("Cucumber", client.LastUpsertRequest.TestType);
        Assert.Equal("QA-1234", jiraClient.LastRequirementIssueKey);
        Assert.Equal("QA-T30001", jiraClient.LastTestIssueKey);
        Assert.Equal("40001", client.LastTestSetAssociationRequest?.ContainerIssueId);
    }

    [Fact]
    public async Task SyncAsync_WarnsOnAmbiguousMatch()
    {
        var client = new StubXrayApiClient();
        var jiraClient = new StubJiraApiClient();
        var service = new XrayTestCaseSyncService(
            client,
            jiraClient,
            new XrayRetrievalOptions
            {
                DefaultCreatedTestType = "Cucumber",
            },
            NullLogger<XrayTestCaseSyncService>.Instance);

        var result = await service.SyncAsync(
            CreateRequest(),
            CreateIssue(),
            CreateScenarioBundle(),
            CreateRepositoryContext(),
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
        Assert.Null(jiraClient.LastRequirementIssueKey);
    }

    [Fact]
    public async Task SyncAsync_UsesIssuePrefix_ForUpsert()
    {
        var client = new StubXrayApiClient();
        var jiraClient = new StubJiraApiClient();
        var service = new XrayTestCaseSyncService(
            client,
            jiraClient,
            new XrayRetrievalOptions
            {
                DefaultCreatedTestType = "Cucumber",
            },
            NullLogger<XrayTestCaseSyncService>.Instance);

        await service.SyncAsync(
            CreateRequest("RM-18999"),
            CreateIssue("RM-18999"),
            CreateScenarioBundle(),
            CreateRepositoryContext(),
            new XrayContextBundle(Array.Empty<XrayTestCase>(), Array.Empty<RunWarning>()),
            CancellationToken.None);

        Assert.NotNull(client.LastUpsertRequest);
        Assert.Equal("RM", client.LastUpsertRequest!.ProjectKey);
    }

    [Fact]
    public async Task SyncAsync_CreatesComponentTestSet_WhenNoExistingComponentSetMatches()
    {
        var client = new StubXrayApiClient
        {
            SearchTestSetsResult = Array.Empty<XrayTestSet>(),
        };
        var service = new XrayTestCaseSyncService(
            client,
            new StubJiraApiClient(),
            new XrayRetrievalOptions
            {
                DefaultCreatedTestType = "Cucumber",
            },
            NullLogger<XrayTestCaseSyncService>.Instance);

        var result = await service.SyncAsync(
            CreateRequest(),
            CreateIssue(),
            CreateScenarioBundle(),
            CreateRepositoryContext(componentPath: "/src/Payments/RetryHandler.cs"),
            new XrayContextBundle(Array.Empty<XrayTestCase>(), Array.Empty<RunWarning>()),
            CancellationToken.None);

        Assert.NotNull(client.LastCreatedTestSetRequest);
        Assert.Equal("bank-otp-api - Payments Test Set", client.LastCreatedTestSetRequest!.Summary);
        Assert.Equal("QA-TS2", Assert.Single(result.Items).TestSetIssueKey);
    }

    [Fact]
    public async Task SyncAsync_Warns_WhenComponentCannotBeInferred()
    {
        var client = new StubXrayApiClient();
        var service = new XrayTestCaseSyncService(
            client,
            new StubJiraApiClient(),
            new XrayRetrievalOptions
            {
                DefaultCreatedTestType = "Cucumber",
            },
            NullLogger<XrayTestCaseSyncService>.Instance);

        var result = await service.SyncAsync(
            CreateRequest(),
            CreateIssue(),
            CreateScenarioBundle(),
            CreateRepositoryContext(
                componentPath: "/src/Callbacks/RetryHandler.cs",
                additionalPath: "/src/Payments/PaymentService.cs"),
            new XrayContextBundle(Array.Empty<XrayTestCase>(), Array.Empty<RunWarning>()),
            CancellationToken.None);

        Assert.Contains(result.Warnings, warning => warning.Code == "xray_component_not_inferred");
        Assert.Null(client.LastTestSetAssociationRequest);
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

    private static JiraIssueContext CreateIssue(string issueKey = "QA-1234")
        => new(
            issueKey,
            "Retry callback",
            "Description",
            "Acceptance criteria",
            "Story",
            "High",
            Array.Empty<JiraCommentContext>(),
            Array.Empty<JiraLinkedIssue>(),
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

    private static RepositoryContextBundle CreateRepositoryContext(
        string componentPath = "/src/Callbacks/RetryHandler.cs",
        string? additionalPath = null)
    {
        var changedFiles = new List<RepositoryFileChange>
        {
            new(componentPath, RepositoryChangeKind.Modified, false, null, null),
            new("/tests/Callbacks/RetryHandlerTests.cs", RepositoryChangeKind.Modified, true, null, null),
        };

        if (!string.IsNullOrWhiteSpace(additionalPath))
        {
            changedFiles.Add(new RepositoryFileChange(additionalPath, RepositoryChangeKind.Modified, false, null, null));
        }

        return new RepositoryContextBundle(
            new RepositoryTarget(
                "bank-otp-api",
                "AzureDevOps",
                "afs-dev",
                "rps",
                "bank-otp-api",
                "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api",
                "main",
                "feature/qa-1234",
                "main",
                882,
                "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/882",
                "source-sha",
                "target-sha",
                "test"),
            new RepositoryConventions(
                "bank-otp-api",
                false,
                "xUnit",
                ".NET 10",
                ["/tests"],
                ["/tests"],
                ["/src"],
                ["dotnet build"],
                ["dotnet test"],
                ["dotnet format"],
                "Tests.cs"),
            changedFiles,
            Array.Empty<NeighboringTestFile>(),
            string.Empty,
            Array.Empty<RunWarning>());
    }

    private sealed class StubXrayApiClient : IXrayApiClient
    {
        public XrayTestCaseUpsertRequest? LastUpsertRequest { get; private set; }
        public XrayAssociationUpdateRequest? LastTestSetAssociationRequest { get; private set; }
        public XrayTestSetCreateRequest? LastCreatedTestSetRequest { get; private set; }
        public IReadOnlyList<XrayTestSet> SearchTestSetsResult { get; init; } =
        [
            new XrayTestSet("40001", "QA-TS1", "bank-otp-api - Callbacks Test Set"),
        ];

        public Task<IReadOnlyList<XrayTestCase>> SearchTestsAsync(
            XrayTestSearchRequest request,
            CancellationToken ct)
            => throw new NotSupportedException();

        public Task<IReadOnlyList<XrayTestSet>> SearchTestSetsAsync(
            XrayTestSetSearchRequest request,
            CancellationToken ct)
            => Task.FromResult(SearchTestSetsResult);

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

        public Task<XrayTestSetCreateResult> CreateTestSetAsync(
            XrayTestSetCreateRequest request,
            CancellationToken ct)
        {
            LastCreatedTestSetRequest = request;
            return Task.FromResult(new XrayTestSetCreateResult("40002", "QA-TS2", true));
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
        {
            LastTestSetAssociationRequest = request;
            return Task.CompletedTask;
        }
    }

    private sealed class StubJiraApiClient : IJiraApiClient
    {
        public string? LastRequirementIssueKey { get; private set; }

        public string? LastTestIssueKey { get; private set; }

        public Task<JiraIssueContext> GetIssueContextAsync(
            string issueKey,
            bool includeComments,
            int maxComments,
            CancellationToken ct)
            => throw new NotSupportedException();

        public Task EnsureTestCoverageLinkAsync(
            string requirementIssueKey,
            string testIssueKey,
            CancellationToken ct)
        {
            LastRequirementIssueKey = requirementIssueKey;
            LastTestIssueKey = testIssueKey;
            return Task.CompletedTask;
        }
    }
}
