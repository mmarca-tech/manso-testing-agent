using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Options;

namespace Manso.Infrastructure;

public sealed class RepositoryAdapterCatalog : IRepositoryAdapterCatalog
{
    private readonly IReadOnlyDictionary<string, IRepositoryAdapter> _adapters;

    public RepositoryAdapterCatalog(IOptions<RepoAdapterOptions> options)
    {
        _adapters = options.Value.Repositories
            .Select(pair => new ConfiguredRepositoryAdapter(pair.Key, pair.Value))
            .Cast<IRepositoryAdapter>()
            .ToDictionary(adapter => adapter.Alias, StringComparer.OrdinalIgnoreCase);
    }

    public IRepositoryAdapter GetRequired(string alias)
    {
        if (_adapters.TryGetValue(alias, out var adapter))
        {
            return adapter;
        }

        throw new InvalidOperationException(
            $"Repository adapter '{alias}' is not configured for this environment.");
    }

    private sealed class ConfiguredRepositoryAdapter : IRepositoryAdapter
    {
        private readonly RepoDefinition _definition;

        public ConfiguredRepositoryAdapter(string alias, RepoDefinition definition)
        {
            Alias = alias;
            _definition = definition;
        }

        public string Alias { get; }

        public bool SupportsExecutableTestGeneration => _definition.SupportsExecutableTestGeneration;

        public Task<RepositoryConventions> GetConventionsAsync(
            RepositoryTarget target,
            CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();

            return Task.FromResult(new RepositoryConventions(
                Alias,
                _definition.SupportsExecutableTestGeneration,
                _definition.TestFramework,
                _definition.TargetFramework,
                NormalizeRoots(_definition.TestDirectoryRoots),
                NormalizeRoots(_definition.AllowedHelperDirectoryRoots),
                NormalizeRoots(_definition.ProtectedPathPrefixes),
                NormalizeCommands(_definition.BuildCommands),
                NormalizeCommands(_definition.TestCommands),
                NormalizeCommands(_definition.FormatterCommands),
                string.IsNullOrWhiteSpace(_definition.TestFileSuffix)
                    ? "Tests.cs"
                    : _definition.TestFileSuffix.Trim()));
        }

        private static IReadOnlyList<string> NormalizeRoots(string[] values)
            => values
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Select(value => NormalizePath(value.Trim()))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();

        private static IReadOnlyList<string> NormalizeCommands(string[] values)
            => values
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Select(value => value.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();

        private static string NormalizePath(string path)
        {
            var normalized = path.Replace('\\', '/').Trim();
            if (!normalized.StartsWith("/", StringComparison.Ordinal))
            {
                normalized = "/" + normalized;
            }

            return normalized.TrimEnd('/');
        }
    }
}
