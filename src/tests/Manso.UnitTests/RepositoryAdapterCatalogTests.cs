using Manso.Domain;
using Manso.Infrastructure;

namespace Manso.UnitTests;

public sealed class RepositoryAdapterCatalogTests
{
    [Fact]
    public async Task RuntimeAdapter_UsesRepoConventionsJson_WhenPresent()
    {
        var adapter = new RepositoryAdapterCatalog().GetRequired("SomeRepo");

        var conventions = await adapter.GetConventionsAsync(
            CreateTarget(),
            [
                new RepositoryGuidanceFile(
                    RepositoryGuidancePaths.RepoConventions,
                    """
                    {
                      "supportsExecutableTestGeneration": true,
                      "testFramework": "xUnit",
                      "targetFramework": ".NET 10",
                      "testDirectoryRoots": ["tests", "/src/Tests"],
                      "allowedHelperDirectoryRoots": ["/tests/helpers"],
                      "protectedPathPrefixes": ["/src/Payments"],
                      "buildCommands": ["dotnet build src/Manso.sln"],
                      "testCommands": ["dotnet test src/Manso.sln"],
                      "formatterCommands": ["dotnet format src/Manso.sln --verify-no-changes"],
                      "linterCommands": ["dotnet format analyzers.sln --verify-no-changes"],
                      "testFileSuffix": "Tests.cs"
                    }
                    """),
            ],
            CancellationToken.None);

        Assert.True(adapter.SupportsExecutableTestGeneration);
        Assert.True(conventions.SupportsExecutableTestGeneration);
        Assert.Equal("xUnit", conventions.TestFramework);
        Assert.Equal(".NET 10", conventions.TargetFramework);
        Assert.Equal(["/tests", "/src/Tests"], conventions.TestDirectoryRoots);
        Assert.Equal(["/tests/helpers"], conventions.AllowedHelperDirectoryRoots);
        Assert.Equal(["/src/Payments"], conventions.ProtectedPathPrefixes);
        Assert.Equal(["dotnet build src/Manso.sln"], conventions.BuildCommands);
        Assert.Equal(["dotnet test src/Manso.sln"], conventions.TestCommands);
        Assert.Equal(["dotnet format src/Manso.sln --verify-no-changes"], conventions.FormatterCommands);
        Assert.Equal(["dotnet format analyzers.sln --verify-no-changes"], conventions.LinterCommands);
    }

    [Fact]
    public async Task RuntimeAdapter_KeepsExecutableGenerationDisabled_WhenRepoConventionsAreMissing()
    {
        var adapter = new RepositoryAdapterCatalog().GetRequired("SomeRepo");

        var conventions = await adapter.GetConventionsAsync(
            CreateTarget(),
            Array.Empty<RepositoryGuidanceFile>(),
            CancellationToken.None);

        Assert.True(adapter.SupportsExecutableTestGeneration);
        Assert.False(conventions.SupportsExecutableTestGeneration);
        Assert.Contains("/tests", conventions.TestDirectoryRoots);
    }

    [Fact]
    public async Task RuntimeAdapter_FailsClearly_WhenRepoConventionsJsonIsInvalid()
    {
        var adapter = new RepositoryAdapterCatalog().GetRequired("SomeRepo");

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            adapter.GetConventionsAsync(
                CreateTarget(),
                [new RepositoryGuidanceFile(RepositoryGuidancePaths.RepoConventions, "{ invalid json")],
                CancellationToken.None));

        Assert.Contains(RepositoryGuidancePaths.RepoConventions, exception.Message);
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
}
