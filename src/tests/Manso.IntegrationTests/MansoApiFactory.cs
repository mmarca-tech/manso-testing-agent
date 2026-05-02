using Manso.Application;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Manso.IntegrationTests;

public sealed class MansoApiFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.ConfigureAppConfiguration((_, config) =>
        {
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["RunIntakeAuthentication:BearerToken"] = "test-token",
                ["RunPersistence:Provider"] = "InMemory",
                ["RunPersistence:AutoInitializeSchema"] = "false",
                ["RequestNormalization:DefaultTestScope"] = "Api",
                ["XrayRetrieval:Enabled"] = "true",
                ["XrayRetrieval:EnableScenarioAutoUpsert"] = "true",
            });
        });
        builder.ConfigureServices(services =>
        {
            services.RemoveAll<IJiraApiClient>();
            services.RemoveAll<IConfluenceApiClient>();
            services.RemoveAll<IXrayApiClient>();
            services.RemoveAll<XrayRetrievalOptions>();
            services.RemoveAll<IScmClient>();
            services.AddSingleton<IJiraApiClient, FakeJiraApiClient>();
            services.AddSingleton<IConfluenceApiClient, FakeConfluenceApiClient>();
            services.AddSingleton<IXrayApiClient, FakeXrayApiClient>();
            services.AddSingleton(new XrayRetrievalOptions
            {
                Enabled = true,
                EnableScenarioAutoUpsert = true,
                DefaultCreatedTestType = "Cucumber",
                MaxNeighboringTests = 5,
            });
            services.AddSingleton<IScmClient, FakeScmClient>();
        });
    }
}
