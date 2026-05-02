using Manso.Application;
using Manso.Infrastructure;
using Microsoft.Extensions.Options;
using System.Text.Json.Serialization;

namespace Manso.Api;

public static class ApiServiceCollectionExtensions
{
    public static IServiceCollection AddApiJsonSerialization(this IServiceCollection services)
    {
        services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
        });

        return services;
    }

    public static IServiceCollection AddApiComposition(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.AddHealthChecks();
        services.AddApiOptions(configuration);
        services.AddSingleton(TimeProvider.System);
        services.AddRunPersistence(configuration);
        services.AddProviderHttpClients();
        services.AddApiDependencies();

        return services;
    }

    private static IServiceCollection AddApiOptions(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.AddBoundOptions<RunIntakeAuthenticationOptions>(
            configuration,
            RunIntakeAuthenticationOptions.SectionName);
        services.AddBoundOptions<JiraOptions>(
            configuration,
            JiraOptions.SectionName);
        services.AddBoundOptions<ConfluenceOptions>(
            configuration,
            ConfluenceOptions.SectionName);
        services.AddBoundOptions<ScmOptions>(
            configuration,
            ScmOptions.SectionName);
        services.AddBoundOptions<XrayOptions>(
            configuration,
            XrayOptions.SectionName);
        services.AddBoundOptions<LlmGatewayOptions>(
            configuration,
            LlmGatewayOptions.SectionName);
        services.AddBoundOptions<RequestNormalizationOptions>(
            configuration,
            RequestNormalizationOptions.SectionName);
        services.AddBoundOptions<ConfluenceLinkOptions>(
            configuration,
            ConfluenceLinkOptions.SectionName);
        services.AddBoundOptions<JiraRetrievalOptions>(
            configuration,
            JiraRetrievalOptions.SectionName);
        services.AddBoundOptions<DocumentationRetrievalOptions>(
            configuration,
            DocumentationRetrievalOptions.SectionName);
        services.AddBoundOptions<XrayRetrievalOptions>(
            configuration,
            XrayRetrievalOptions.SectionName);
        services.AddBoundOptions<RepositoryRetrievalOptions>(
            configuration,
            RepositoryRetrievalOptions.SectionName);
        services.AddBoundOptions<GenerationContextOptions>(
            configuration,
            GenerationContextOptions.SectionName);
        services.AddBoundOptions<ScenarioGenerationOptions>(
            configuration,
            ScenarioGenerationOptions.SectionName);
        services.AddBoundOptions<RuntimePromptOptions>(
            configuration,
            RuntimePromptOptions.SectionName);

        return services;
    }

    private static IServiceCollection AddApiDependencies(this IServiceCollection services)
    {
        services.AddSingleton<IRunIdFactory, UtcTimestampRunIdFactory>();
        services.AddSingleton<IBackgroundRunQueue, ChannelBackgroundRunQueue>();
        services.AddSingleton<DocumentationLinkNormalizer>();
        services.AddSingleton<IRequestNormalizer, RequestNormalizer>();
        services.AddSingleton<AtlassianDocumentTextExtractor>();
        services.AddSingleton<IJiraApiClient, JiraApiClient>();
        services.AddSingleton<IConfluenceApiClient, ConfluenceApiClient>();
        services.AddSingleton<IXrayApiClient, XrayCloudApiClient>();
        services.AddSingleton<IScmClient, AzureDevOpsScmClient>();
        services.AddSingleton<ILlmGateway>(static serviceProvider =>
        {
            var options = serviceProvider.GetRequiredService<IOptions<LlmGatewayOptions>>().Value;
            return options.Provider switch
            {
                LlmProvider.Mock => ActivatorUtilities.CreateInstance<MockLlmGateway>(serviceProvider),
                LlmProvider.OpenAi => ActivatorUtilities.CreateInstance<OpenAiLlmGateway>(serviceProvider),
                LlmProvider.Anthropic => ActivatorUtilities.CreateInstance<AnthropicLlmGateway>(serviceProvider),
                _ => ActivatorUtilities.CreateInstance<DisabledLlmGateway>(serviceProvider),
            };
        });
        services.AddSingleton<IJiraContextService, JiraContextService>();
        services.AddSingleton<IDocumentationResolver, DocumentationResolver>();
        services.AddSingleton<IRepositoryResolver, RepositoryResolver>();
        services.AddSingleton<IRepositoryAdapterCatalog, RepositoryAdapterCatalog>();
        services.AddSingleton<IRepositoryContextService, RepositoryContextService>();
        services.AddSingleton<IXrayContextService, XrayContextService>();
        services.AddSingleton<IXrayTestCaseSyncService, XrayTestCaseSyncService>();
        services.AddSingleton<IRuntimePromptSectionProvider, MarkdownRuntimePromptSectionProvider>();
        services.AddSingleton<IGenerationContextBundleBuilder, GenerationContextBundleBuilder>();
        services.AddSingleton<IScenarioGenerator, ScenarioGenerator>();
        services.AddSingleton<IOutputValidator, OutputValidator>();
        services.AddSingleton<IOutputWriter, OutputWriter>();
        services.AddSingleton<ITestGenerationRunService, TestGenerationRunService>();
        services.AddHostedService<RunExecutionBackgroundService>();

        return services;
    }

    private static IServiceCollection AddProviderHttpClients(this IServiceCollection services)
    {
        services.AddConfiguredHttpClient<JiraOptions>(
            "JiraApi",
            static options => options.BaseUrl);
        services.AddConfiguredHttpClient<ConfluenceOptions>(
            "ConfluenceApi",
            static options => options.BaseUrl);
        services.AddConfiguredHttpClient<ScmOptions>(
            "ScmApi",
            static options => options.BaseUrl);
        services.AddConfiguredHttpClient<XrayOptions>(
            "XrayApi",
            static options => options.BaseUrl);
        services.AddConfiguredHttpClient<LlmGatewayOptions>(
            "LlmApi",
            static options => options.BaseUrl,
            static (options, client) =>
            {
                if (options.RequestTimeoutSeconds > 0)
                {
                    client.Timeout = TimeSpan.FromSeconds(options.RequestTimeoutSeconds);
                }
            });

        return services;
    }

    private static IHttpClientBuilder AddConfiguredHttpClient<TOptions>(
        this IServiceCollection services,
        string name,
        Func<TOptions, string?> baseUrlSelector,
        Action<TOptions, HttpClient>? configureClient = null)
        where TOptions : class
    {
        return services.AddHttpClient(name, (serviceProvider, client) =>
        {
            var options = serviceProvider.GetRequiredService<IOptions<TOptions>>().Value;
            if (Uri.TryCreate(baseUrlSelector(options), UriKind.Absolute, out var baseUri))
            {
                client.BaseAddress = baseUri;
            }

            configureClient?.Invoke(options, client);
        });
    }

    private static IServiceCollection AddBoundOptions<TOptions>(
        this IServiceCollection services,
        IConfiguration configuration,
        string sectionName)
        where TOptions : class, new()
    {
        services.AddOptions<TOptions>()
            .Bind(configuration.GetSection(sectionName));
        services.AddSingleton(serviceProvider =>
            serviceProvider.GetRequiredService<IOptions<TOptions>>().Value);

        return services;
    }
}
