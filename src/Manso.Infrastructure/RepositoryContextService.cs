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
        var adapter = _repositoryAdapterCatalog.GetRequired(target.Alias);
        var conventions = await adapter.GetConventionsAsync(target, ct);
        var context = await _scmClient.GetCodeContextAsync(target, _options, conventions, ct);

        if (context.ChangedFiles.Count == 0)
        {
            throw new InvalidOperationException(
                $"Resolved repository target '{target.Alias}' returned no changed files.");
        }

        _logger.LogInformation(
            "Collected repository context for {Alias} with {ChangedFileCount} changed files using adapter {AdapterAlias}.",
            target.Alias,
            context.ChangedFiles.Count,
            conventions.AdapterAlias);

        return context;
    }
}
