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
                ["RequestNormalization:AllowedConfluenceHosts:0"] = "yourcompany.atlassian.net",
                ["RequestNormalization:DefaultTestScope"] = "Api",
                ["RequestNormalization:DefaultGenerationMode"] = "TestCasesOnly",
                ["RequestNormalization:DefaultCoverageIntent"] = "Regression",
                ["RequestNormalization:DefaultOutputTarget"] = "JiraComment",
                ["XrayRetrieval:Enabled"] = "true",
                ["XrayRetrieval:ProjectKey"] = "QA",
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
                ProjectKey = "QA",
                EnableScenarioAutoUpsert = true,
                DefaultCreatedTestType = "Cucumber",
                MaxNeighboringTests = 5,
                SearchJqlTemplate = "project = {XRAY_PROJECT_KEY} AND issuetype = Test AND (text ~ \"\\\"{ISSUE_KEY}\\\"\" OR text ~ \"\\\"{ISSUE_SUMMARY}\\\"\") ORDER BY updated DESC",
            });
            services.AddSingleton<IScmClient, FakeScmClient>();
        });
    }
}
