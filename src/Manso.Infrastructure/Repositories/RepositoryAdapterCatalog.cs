using Manso.Application;
using Manso.Domain;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Manso.Infrastructure;

public sealed class RepositoryAdapterCatalog : IRepositoryAdapterCatalog
{
    public IRepositoryAdapter GetRequired(string alias)
    {
        if (string.IsNullOrWhiteSpace(alias))
        {
            throw new InvalidOperationException("Repository alias is required to build repository conventions.");
        }

        return new RuntimeRepositoryAdapter(alias.Trim());
    }

    private sealed class RuntimeRepositoryAdapter : IRepositoryAdapter
    {
        private static readonly IReadOnlyList<string> DefaultTestDirectoryRoots =
        [
            "/tests",
            "/test",
            "/src/tests",
            "/src/test",
        ];

        public RuntimeRepositoryAdapter(string alias)
        {
            Alias = alias;
        }

        public string Alias { get; }

        public bool SupportsExecutableTestGeneration => true;

        public Task<RepositoryConventions> GetConventionsAsync(
            RepositoryTarget target,
            IReadOnlyList<RepositoryGuidanceFile> guidanceFiles,
            CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();

            var conventionsFile = guidanceFiles.FirstOrDefault(file =>
                NormalizePath(file.Path).Equals(RepositoryGuidancePaths.RepoConventions, StringComparison.OrdinalIgnoreCase));
            if (conventionsFile is null)
            {
                return Task.FromResult(CreateDefaultConventions(supportsExecutableGeneration: false));
            }

            var document = ParseConventionsDocument(conventionsFile);
            var conventions = new RepositoryConventions(
                Alias,
                document.SupportsExecutableTestGeneration == true,
                NormalizeOptional(document.TestFramework),
                NormalizeOptional(document.TargetFramework),
                NormalizePathList(document.TestDirectoryRoots, DefaultTestDirectoryRoots),
                NormalizePathList(document.AllowedHelperDirectoryRoots, Array.Empty<string>()),
                NormalizePathList(document.ProtectedPathPrefixes, Array.Empty<string>()),
                NormalizeCommandList(document.BuildCommands),
                NormalizeCommandList(document.TestCommands),
                NormalizeCommandList(document.FormatterCommands),
                NormalizeOptional(document.TestFileSuffix, "Tests.cs"))
            {
                LinterCommands = NormalizeCommandList(document.LinterCommands),
            };

            return Task.FromResult(conventions);
        }

        private RepositoryConventions CreateDefaultConventions(bool supportsExecutableGeneration)
            => new(
                Alias,
                supportsExecutableGeneration,
                string.Empty,
                string.Empty,
                DefaultTestDirectoryRoots,
                Array.Empty<string>(),
                Array.Empty<string>(),
                Array.Empty<string>(),
                Array.Empty<string>(),
                Array.Empty<string>(),
                "Tests.cs");

        private static RepositoryConventionsDocument ParseConventionsDocument(RepositoryGuidanceFile file)
        {
            try
            {
                return JsonSerializer.Deserialize<RepositoryConventionsDocument>(
                           file.Content,
                           RepositoryConventionsJsonOptions.Instance)
                       ?? new RepositoryConventionsDocument();
            }
            catch (JsonException ex)
            {
                throw new InvalidOperationException(
                    $"Repository conventions file '{file.Path}' is not valid JSON: {ex.Message}",
                    ex);
            }
        }

        private static IReadOnlyList<string> NormalizePathList(
            IReadOnlyList<string>? values,
            IReadOnlyList<string> fallback)
        {
            var normalized = values?
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Select(NormalizePath)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();

            return normalized is { Length: > 0 }
                ? normalized
                : fallback;
        }

        private static IReadOnlyList<string> NormalizeCommandList(IReadOnlyList<string>? values)
            => values?
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Select(value => value.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
               ?? Array.Empty<string>();

        private static string NormalizeOptional(string? value, string fallback = "")
            => string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();

        private static string NormalizePath(string value)
        {
            var normalized = value.Replace('\\', '/').Trim();
            if (string.IsNullOrWhiteSpace(normalized))
            {
                return "/";
            }

            return normalized.StartsWith("/", StringComparison.Ordinal)
                ? normalized
                : $"/{normalized}";
        }

        private sealed class RepositoryConventionsDocument
        {
            public bool? SupportsExecutableTestGeneration { get; init; }

            public string? TestFramework { get; init; }

            public string? TargetFramework { get; init; }

            public string? TestFileSuffix { get; init; }

            public IReadOnlyList<string>? TestDirectoryRoots { get; init; }

            public IReadOnlyList<string>? AllowedHelperDirectoryRoots { get; init; }

            public IReadOnlyList<string>? ProtectedPathPrefixes { get; init; }

            public IReadOnlyList<string>? BuildCommands { get; init; }

            public IReadOnlyList<string>? TestCommands { get; init; }

            public IReadOnlyList<string>? FormatterCommands { get; init; }

            public IReadOnlyList<string>? LinterCommands { get; init; }
        }

        private static class RepositoryConventionsJsonOptions
        {
            public static readonly JsonSerializerOptions Instance = new()
            {
                PropertyNameCaseInsensitive = true,
                ReadCommentHandling = JsonCommentHandling.Skip,
                AllowTrailingCommas = true,
                Converters = { new JsonStringEnumConverter() },
            };
        }
    }
}
