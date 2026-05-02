using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging;

namespace Manso.Infrastructure;

public sealed class RepositoryContextService : IRepositoryContextService
{
    private readonly IRepositoryAdapterCatalog _repositoryAdapterCatalog;
    private readonly RepositoryRetrievalOptions _options;
    private readonly IScmClient _scmClient;
    private readonly ILogger<RepositoryContextService> _logger;

    public RepositoryContextService(
        IRepositoryAdapterCatalog repositoryAdapterCatalog,
        RepositoryRetrievalOptions options,
        IScmClient scmClient,
        ILogger<RepositoryContextService> logger)
    {
        _repositoryAdapterCatalog = repositoryAdapterCatalog;
        _options = options;
        _scmClient = scmClient;
        _logger = logger;
    }

    public async Task<RepositoryContextBundle> BuildAsync(
        RepositoryTarget target,
        NormalizedRunRequest request,
        CancellationToken ct)
    {
        var guidanceFiles = await _scmClient.GetRepositoryFilesAsync(
            target,
            RepositoryGuidancePaths.All,
            ct);
        var adapter = _repositoryAdapterCatalog.GetRequired(target.Alias);
        var conventions = await adapter.GetConventionsAsync(target, guidanceFiles, ct);
        var context = await _scmClient.GetCodeContextAsync(target, _options, conventions, ct);

        if (context.ChangedFiles.Count == 0)
        {
            throw new InvalidOperationException(
                $"Resolved repository target '{target.Alias}' returned no changed files.");
        }

        var warnings = context.Warnings.ToList();
        if (guidanceFiles.Count == 0)
        {
            warnings.Add(new RunWarning(
                "repo_test_generation_guidance_missing",
                $"Repository '{target.Alias}' does not contain Manso test-generation guidance at the approved fixed paths."));
        }

        _logger.LogInformation(
            "Collected repository context for {Alias} with {ChangedFileCount} changed files, {GuidanceFileCount} guidance files, and adapter {AdapterAlias}.",
            target.Alias,
            context.ChangedFiles.Count,
            guidanceFiles.Count,
            conventions.AdapterAlias);

        return context with
        {
            GuidanceFiles = guidanceFiles,
            ProviderRequestCount = context.ProviderRequestCount + CountGuidanceFileRequests(RepositoryGuidancePaths.All),
            Warnings = warnings,
        };
    }

    private static int CountGuidanceFileRequests(IReadOnlyList<string> paths)
        => paths
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Select(path => path.Replace('\\', '/'))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Count();
}
