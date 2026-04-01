using Manso.Application;
using Manso.Domain;

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

        public bool SupportsExecutableTestGeneration => false;

        public Task<RepositoryConventions> GetConventionsAsync(
            RepositoryTarget target,
            CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();

            return Task.FromResult(new RepositoryConventions(
                Alias,
                SupportsExecutableTestGeneration,
                string.Empty,
                string.Empty,
                DefaultTestDirectoryRoots,
                Array.Empty<string>(),
                Array.Empty<string>(),
                Array.Empty<string>(),
                Array.Empty<string>(),
                Array.Empty<string>(),
                "Tests.cs"));
        }
    }
}
