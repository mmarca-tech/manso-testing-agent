using System.Net;
using System.Text;
using Manso.Application;
using Manso.Domain;
using Manso.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Manso.UnitTests;

public sealed class XrayCloudApiClientTests
{
    [Fact]
    public async Task SearchTestsAsync_AuthenticatesAndParsesExpandedTests()
    {
        var client = new XrayCloudApiClient(
            new StubHttpClientFactory(new HttpClient(new StubHttpMessageHandler())),
            Options.Create(new XrayOptions
            {
                BaseUrl = "https://xray.cloud.getxray.app/api/v2/",
                ClientId = "client-id",
                ClientSecret = "client-secret",
            }),
            NullLogger<XrayCloudApiClient>.Instance);

        var results = await client.SearchTestsAsync(
            new XrayTestSearchRequest("project = QA", 10),
            CancellationToken.None);

        var first = Assert.Single(results);
        Assert.Equal("20001", first.IssueId);
        Assert.Equal("QA-T1", first.IssueKey);
        Assert.Equal("Retry callback", first.Summary);
        Assert.Equal("Cucumber", first.TestType);
        Assert.Equal("Scenario: Retry callback", first.Gherkin);
    }

    private sealed class StubHttpClientFactory : IHttpClientFactory
    {
        private readonly HttpClient _client;

        public StubHttpClientFactory(HttpClient client)
        {
            _client = client;
            _client.BaseAddress = new Uri("https://xray.cloud.getxray.app/api/v2/");
        }

        public HttpClient CreateClient(string name) => _client;
    }

    private sealed class StubHttpMessageHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri?.PathAndQuery ?? string.Empty;

            return Task.FromResult(path switch
            {
                var value when value.Contains("authenticate", StringComparison.OrdinalIgnoreCase)
                    => Json("\"fake-access-token\""),
                var value when value.Contains("graphql", StringComparison.OrdinalIgnoreCase)
                    => Json(
                        """
                        {
                          "data": {
                            "getExpandedTests": {
                              "results": [
                                {
                                  "issueId": "20001",
                                  "testType": { "name": "Cucumber" },
                                  "gherkin": "Scenario: Retry callback",
                                  "steps": [],
                                  "jira": {
                                    "key": "QA-T1",
                                    "summary": "Retry callback",
                                    "labels": ["payments"]
                                  }
                                }
                              ]
                            }
                          }
                        }
                        """),
                _ => new HttpResponseMessage(HttpStatusCode.NotFound),
            });
        }

        private static HttpResponseMessage Json(string json)
            => new(HttpStatusCode.OK)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json"),
            };
    }
}
