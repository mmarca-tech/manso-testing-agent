using Manso.Application;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Manso.Infrastructure;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddRunPersistence(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        var options = configuration.GetSection(RunPersistenceOptions.SectionName).Get<RunPersistenceOptions>()
                      ?? new RunPersistenceOptions();

        services.AddSingleton(options);
        services.AddSingleton<RunStoreJsonSerializer>();

        switch (options.Provider)
        {
            case RunPersistenceProvider.InMemory:
                services.AddSingleton<IRunStore, InMemoryRunStore>();
                services.AddSingleton<RunStoreSchemaInitializer>();
                break;

            case RunPersistenceProvider.Postgres:
                {
                    var connectionString = configuration.GetConnectionString("RunStore");
                    if (string.IsNullOrWhiteSpace(connectionString))
                    {
                        throw new InvalidOperationException(
                            "ConnectionStrings:RunStore must be configured when RunPersistence provider is Postgres.");
                    }

                    services.AddSingleton(_ =>
                    {
                        var builder = new NpgsqlDataSourceBuilder(connectionString);
                        return builder.Build();
                    });
                    services.AddSingleton<IRunStore, PostgresRunStore>();
                    services.AddSingleton<RunStoreSchemaInitializer>();
                    break;
                }

            default:
                throw new InvalidOperationException($"Unsupported run persistence provider '{options.Provider}'.");
        }

        return services;
    }
}
