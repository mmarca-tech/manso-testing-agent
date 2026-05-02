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
        var scmClient = new StubScmClient(new RepositoryContextBundle(
            CreateTarget(),
            CreateConventions(),
            [new RepositoryFileChange("/src/RetryHandler.cs", RepositoryChangeKind.Modified, false, null, "--- a/src/RetryHandler.cs")],
            [new NeighboringTestFile("/tests/RetryHandlerTests.cs", "path similarity", "[Fact] public void Existing() { }")],
            "--- a/src/RetryHandler.cs",
            Array.Empty<RunWarning>())
        {
            ProviderRequestCount = 3,
        })
        {
            GuidanceFiles =
            [
                new RepositoryGuidanceFile(
                    RepositoryGuidancePaths.RepoConventions,
                    """
                    {
                      "supportsExecutableTestGeneration": true,
                      "testFramework": "xUnit",
                      "targetFramework": ".NET 10",
                      "testDirectoryRoots": ["/tests", "/src/Tests"],
                      "allowedHelperDirectoryRoots": ["/tests/helpers"],
                      "buildCommands": ["dotnet build src/Manso.sln"],
                      "testCommands": ["dotnet test src/Manso.sln"],
                      "testFileSuffix": "Tests.cs"
                    }
                    """),
            ],
        };
        var service = new RepositoryContextService(
            CreateCatalog(),
            new RepositoryRetrievalOptions { MaxChangedFiles = 10, MaxDiffLinesPerFile = 40 },
            scmClient,
            NullLogger<RepositoryContextService>.Instance);

        var result = await service.BuildAsync(CreateTarget(), CreateRequest(), CancellationToken.None);

        Assert.Single(result.ChangedFiles);
        Assert.Equal("/src/RetryHandler.cs", result.ChangedFiles[0].Path);
        Assert.Equal("SomeRepo", result.Conventions.AdapterAlias);
        Assert.True(result.Conventions.SupportsExecutableTestGeneration);
        Assert.Contains("/tests", result.Conventions.TestDirectoryRoots);
        Assert.Contains(RepositoryGuidancePaths.RepoConventions, scmClient.RequestedPaths);
        Assert.Single(result.GuidanceFiles);
        Assert.Equal(7, result.ProviderRequestCount);
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

    [Fact]
    public async Task BuildAsync_AddsWarning_WhenRepoGuidanceIsMissing()
    {
        var service = new RepositoryContextService(
            CreateCatalog(),
            new RepositoryRetrievalOptions(),
            new StubScmClient(new RepositoryContextBundle(
                CreateTarget(),
                CreateConventions(),
                [new RepositoryFileChange("/src/RetryHandler.cs", RepositoryChangeKind.Modified, false, null, "--- a/src/RetryHandler.cs")],
                Array.Empty<NeighboringTestFile>(),
                "--- a/src/RetryHandler.cs",
                Array.Empty<RunWarning>())),
            NullLogger<RepositoryContextService>.Instance);

        var result = await service.BuildAsync(CreateTarget(), CreateRequest(), CancellationToken.None);

        Assert.False(result.Conventions.SupportsExecutableTestGeneration);
        Assert.Contains(result.Warnings, warning => warning.Code == "repo_test_generation_guidance_missing");
    }

    private static RepositoryTarget CreateTarget()
        => new(
            "SomeRepo",
            "AzureDevOps",
            "SomeProject",
            "SomeTeam",
            "SomeRepo",
            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo",
            "main",
            "feature/qa-1234",
            "main",
            882,
            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/882",
            "source-sha",
            "target-sha",
            "manual_pr_hint");

    private static NormalizedRunRequest CreateRequest()
        => new(
            "QA-1234",
            WorkflowPass.ScenarioDesign,
            TestScope.Api,
            "SomeRepo",
            "abc");

    private static IRepositoryAdapterCatalog CreateCatalog()
        => new RepositoryAdapterCatalog();

    private static RepositoryConventions CreateConventions()
        => new(
            "SomeRepo",
            false,
            string.Empty,
            string.Empty,
            ["/tests", "/test", "/src/tests", "/src/test"],
            Array.Empty<string>(),
            Array.Empty<string>(),
            Array.Empty<string>(),
            Array.Empty<string>(),
            Array.Empty<string>(),
            "Tests.cs");

    private sealed class StubScmClient : IScmClient
    {
        private readonly RepositoryContextBundle _context;

        public IReadOnlyList<RepositoryGuidanceFile> GuidanceFiles { get; init; } = Array.Empty<RepositoryGuidanceFile>();

        public List<string> RequestedPaths { get; } = [];

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
            => Task.FromResult(_context with { Conventions = conventions });

        public Task<IReadOnlyList<RepositoryGuidanceFile>> GetRepositoryFilesAsync(
            RepositoryTarget target,
            IReadOnlyList<string> paths,
            CancellationToken ct)
        {
            RequestedPaths.AddRange(paths);
            return Task.FromResult(GuidanceFiles);
        }

    }
}
