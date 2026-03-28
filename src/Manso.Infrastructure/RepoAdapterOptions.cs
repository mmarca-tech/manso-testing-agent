namespace Manso.Infrastructure;

public sealed class RepoAdapterOptions
{
    public const string SectionName = "RepoAdapters";

    public Dictionary<string, RepoDefinition> Repositories { get; init; } = new(StringComparer.OrdinalIgnoreCase);
}

public sealed class RepoDefinition
{
    public string Provider { get; init; } = string.Empty;

    public string Organization { get; init; } = string.Empty;

    public string Project { get; init; } = string.Empty;

    public string RepositoryName { get; init; } = string.Empty;

    public string RepositoryUrl { get; init; } = string.Empty;

    public string DefaultBranch { get; init; } = string.Empty;

    public bool SupportsExecutableTestGeneration { get; init; }

    public string TestFramework { get; init; } = string.Empty;

    public string TargetFramework { get; init; } = string.Empty;

    public string TestFileSuffix { get; init; } = "Tests.cs";

    public string[] TestDirectoryRoots { get; init; } = Array.Empty<string>();

    public string[] AllowedHelperDirectoryRoots { get; init; } = Array.Empty<string>();

    public string[] ProtectedPathPrefixes { get; init; } = Array.Empty<string>();

    public string[] BuildCommands { get; init; } = Array.Empty<string>();

    public string[] TestCommands { get; init; } = Array.Empty<string>();

    public string[] FormatterCommands { get; init; } = Array.Empty<string>();
}
