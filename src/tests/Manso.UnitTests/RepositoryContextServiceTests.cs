using Manso.Application;
using Manso.Domain;
using Manso.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;

namespace Manso.UnitTests;

public sealed class RepositoryContextServiceTests
{
    [Fact]
    public async Task BuildAsync_ReturnsContext_WhenChangedFilesExist()
    {
        var service = new RepositoryContextService(
            CreateCatalog(),
            new RepositoryRetrievalOptions { MaxChangedFiles = 10, MaxDiffLinesPerFile = 40 },
            new StubScmClient(new RepositoryContextBundle(
                CreateTarget(),
                CreateConventions(),
                [new RepositoryFileChange("/src/RetryHandler.cs", RepositoryChangeKind.Modified, false, null, "--- a/src/RetryHandler.cs")],
                [new NeighboringTestFile("/tests/RetryHandlerTests.cs", "path similarity", "[Fact] public void Existing() { }")],
                "--- a/src/RetryHandler.cs",
                Array.Empty<RunWarning>())),
            NullLogger<RepositoryContextService>.Instance);

        var result = await service.BuildAsync(CreateTarget(), CreateRequest(), CancellationToken.None);

        Assert.Single(result.ChangedFiles);
        Assert.Equal("/src/RetryHandler.cs", result.ChangedFiles[0].Path);
        Assert.Equal("xUnit", result.Conventions.TestFramework);
    }

    [Fact]
    public async Task BuildAsync_Fails_WhenNoChangedFilesExist()
    {
        var service = new RepositoryContextService(
            CreateCatalog(),
            new RepositoryRetrievalOptions(),
            new StubScmClient(new RepositoryContextBundle(
                CreateTarget(),
                CreateConventions(),
                Array.Empty<RepositoryFileChange>(),
                Array.Empty<NeighboringTestFile>(),
                string.Empty,
                Array.Empty<RunWarning>())),
            NullLogger<RepositoryContextService>.Instance);

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.BuildAsync(CreateTarget(), CreateRequest(), CancellationToken.None));
    }

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
            "manual_pr_hint");

    private static NormalizedRunRequest CreateRequest()
        => new(
            "QA-1234",
            "https://yourcompany.atlassian.net/browse/QA-1234",
            GenerationMode.TestCasesOnly,
            WorkflowPass.ScenarioDesign,
            TestScope.Api,
            "bank-otp-api",
            "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/882",
            Array.Empty<string>(),
            CoverageIntent.Regression,
            OutputTarget.JiraComment,
            new RequestedBy("abc", "Manuel", "manuel@example.com"),
            DocumentationMode.ExplicitOnly);

    private static IRepositoryAdapterCatalog CreateCatalog()
        => new RepositoryAdapterCatalog(Microsoft.Extensions.Options.Options.Create(new RepoAdapterOptions
        {
            Repositories = new Dictionary<string, RepoDefinition>(StringComparer.OrdinalIgnoreCase)
            {
                ["bank-otp-api"] = new()
                {
                    Provider = "AzureDevOps",
                    Organization = "afs-dev",
                    Project = "rps",
                    RepositoryName = "bank-otp-api",
                    RepositoryUrl = "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api",
                    DefaultBranch = "main",
                    SupportsExecutableTestGeneration = false,
                    TestFramework = "xUnit",
                    TargetFramework = ".NET 10",
                    TestDirectoryRoots = ["/tests", "/src/Tests"],
                    AllowedHelperDirectoryRoots = ["/tests/helpers"],
                    ProtectedPathPrefixes = ["/src"],
                    BuildCommands = ["dotnet build src/Manso.sln"],
                    TestCommands = ["dotnet test src/Manso.sln"],
                    FormatterCommands = ["dotnet format src/Manso.sln --verify-no-changes"],
                    TestFileSuffix = "Tests.cs",
                },
            },
        }));

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

    private sealed class StubScmClient : IScmClient
    {
        private readonly RepositoryContextBundle _context;

        public StubScmClient(RepositoryContextBundle context)
        {
            _context = context;
        }

        public Task<RepositoryPullRequest> GetPullRequestAsync(
            RepositoryTarget repository,
            int pullRequestId,
            CancellationToken ct)
            => throw new NotSupportedException();

        public Task<RepositoryContextBundle> GetCodeContextAsync(
            RepositoryTarget target,
            RepositoryRetrievalOptions options,
            RepositoryConventions conventions,
            CancellationToken ct)
            => Task.FromResult(_context);

        public Task<RepositoryWriteExecutionResult> WriteAsync(
            RepositoryTarget target,
            RepositoryWritePlan plan,
            CancellationToken ct)
            => throw new NotSupportedException();
    }
}
