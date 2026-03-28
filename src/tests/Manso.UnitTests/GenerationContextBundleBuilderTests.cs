using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging.Abstractions;

namespace Manso.UnitTests;

public sealed class GenerationContextBundleBuilderTests
{
    [Fact]
    public async Task BuildAsync_IncludesNeighboringTestsAndRepoSections_WhenRepositoryContextExists()
    {
        var builder = new GenerationContextBundleBuilder(
            new GenerationContextOptions
            {
                MaxChangedFileExcerpts = 5,
                MaxNeighboringTests = 3,
                MaxComments = 3,
            },
            NullLogger<GenerationContextBundleBuilder>.Instance);

        var bundle = await builder.BuildAsync(
            CreateRequest(),
            CreateIssue(),
            CreateDocuments(),
            CreateTarget(),
            new RepositoryContextBundle(
                CreateTarget(),
                CreateConventions(),
                [new RepositoryFileChange("/src/Callbacks/RetryHandler.cs", RepositoryChangeKind.Modified, false, null, "--- a/src/Callbacks/RetryHandler.cs")],
                [new NeighboringTestFile("/tests/Callbacks/RetryHandlerTests.cs", "path similarity", "[Fact] public void Existing() { }")],
                "--- a/src/Callbacks/RetryHandler.cs",
                Array.Empty<RunWarning>()),
            CreateXrayContext(),
            CancellationToken.None);

        Assert.Contains(bundle.Sections, section => section.Key == "repo_change_summary");
        Assert.Contains(bundle.Sections, section => section.Key == "neighboring_test_patterns");
        Assert.Contains(bundle.Sections, section => section.Key == "xray_neighboring_tests");
        Assert.Contains(bundle.Sections, section => section.Key == "repo_test_conventions");
        Assert.Equal(1, bundle.NeighboringTestCount);
        Assert.Equal(1, bundle.XrayNeighboringTestCount);
        Assert.Empty(bundle.Warnings);
        Assert.Contains(
            "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/882",
            bundle.Sections.Single(section => section.Key == "run_metadata").Content);
    }

    [Fact]
    public async Task BuildAsync_AddsWarnings_WhenRepositoryContextIsMissing()
    {
        var builder = new GenerationContextBundleBuilder(
            new GenerationContextOptions(),
            NullLogger<GenerationContextBundleBuilder>.Instance);

        var bundle = await builder.BuildAsync(
            CreateRequest(),
            CreateIssue(),
            CreateDocuments(),
            null,
            null,
            new XrayContextBundle(Array.Empty<XrayTestCase>(), Array.Empty<RunWarning>()),
            CancellationToken.None);

        Assert.Contains(bundle.Warnings, warning => warning.Code == "generation_context_without_code_diff");
        Assert.Contains(bundle.Warnings, warning => warning.Code == "generation_context_without_neighboring_tests");
        Assert.Contains(bundle.Sections, section => section.Key == "repo_change_summary");
    }

    [Fact]
    public async Task BuildAsync_ListsAllPullRequestReferences_WhenRepositoryTargetAggregatesMergedPullRequests()
    {
        var builder = new GenerationContextBundleBuilder(
            new GenerationContextOptions(),
            NullLogger<GenerationContextBundleBuilder>.Instance);

        var repositoryTarget = CreateTarget() with
        {
            PullRequestId = null,
            PullRequestReference = null,
            PullRequestIds = [881, 882],
            PullRequestReferences =
            [
                "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/881",
                "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/882",
            ],
        };

        var bundle = await builder.BuildAsync(
            CreateRequest() with { WorkflowPass = WorkflowPass.AutomationImplementation },
            CreateIssue(),
            CreateDocuments(),
            repositoryTarget,
            new RepositoryContextBundle(
                repositoryTarget,
                CreateConventions(),
                [new RepositoryFileChange("/src/Callbacks/RetryHandler.cs", RepositoryChangeKind.Modified, false, null, "--- a/src/Callbacks/RetryHandler.cs")],
                Array.Empty<NeighboringTestFile>(),
                "--- a/src/Callbacks/RetryHandler.cs",
                Array.Empty<RunWarning>()),
            new XrayContextBundle(Array.Empty<XrayTestCase>(), Array.Empty<RunWarning>()),
            CancellationToken.None);

        var runMetadata = bundle.Sections.Single(section => section.Key == "run_metadata").Content;
        Assert.Contains("pullrequest/881", runMetadata);
        Assert.Contains("pullrequest/882", runMetadata);
    }

    private static NormalizedRunRequest CreateRequest()
        => new(
            "QA-1234",
            "https://yourcompany.atlassian.net/browse/QA-1234",
            GenerationMode.TestCasesOnly,
            WorkflowPass.ScenarioDesign,
            TestScope.Api,
            "bank-otp-api",
            "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/882",
            [
                "https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+Flow",
            ],
            CoverageIntent.Regression,
            OutputTarget.JiraComment,
            new RequestedBy("abc", "Manuel", "manuel@example.com"),
            DocumentationMode.ExplicitOnly);

    private static JiraIssueContext CreateIssue()
        => new(
            "QA-1234",
            "Retry callback",
            "Issue description",
            "Retries must be idempotent.",
            "Story",
            "High",
            [new JiraCommentContext("1", "Alice", "Check edge cases", DateTimeOffset.UtcNow)],
            ["QA-1111"],
            ["payments"],
            Array.Empty<JiraDevelopmentRepository>());

    private static IReadOnlyList<ConfluenceDocument> CreateDocuments()
        => [
            new ConfluenceDocument(
                "https://yourcompany.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+Flow",
                "12345",
                "Retry Flow",
                "ENG",
                1,
                DateTimeOffset.UtcNow,
                [new ConfluenceChunk("12345-1", "Overview", "Retry overview", 3)])
        ];

    private static RepositoryTarget CreateTarget()
        => new(
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
            "manual_pr_hint")
        {
            PullRequestIds = [882],
            PullRequestReferences = ["https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/882"],
        };

    private static RepositoryConventions CreateConventions()
        => new(
            "bank-otp-api",
            false,
            "xUnit",
            ".NET 10",
            ["/tests", "/src/Tests"],
            ["/tests/helpers"],
            ["/src"],
            ["dotnet build src/Manso.sln"],
            ["dotnet test src/Manso.sln"],
            ["dotnet format src/Manso.sln --verify-no-changes"],
            "Tests.cs");

    private static XrayContextBundle CreateXrayContext()
        => new(
            [
                new XrayTestCase(
                    "20001",
                    "QA-T1",
                    "Retry transient callback failure",
                    "Cucumber",
                    "Scenario: Retry transient callback failure",
                    Array.Empty<XrayTestStep>(),
                    ["payments"])
            ],
            Array.Empty<RunWarning>());
}
