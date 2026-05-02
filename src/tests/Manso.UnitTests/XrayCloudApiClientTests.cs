using Manso.Domain;
using Manso.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using System.Net;
using System.Text;

namespace Manso.UnitTests;

public sealed class XrayCloudApiClientTests
{
    [Fact]
    public async Task SearchTestsAsync_AuthenticatesAndParsesExpandedTests()
    {
        var client = CreateClient(new SearchTestsHandler());

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

    [Fact]
    public async Task SearchTestsAsync_Reauthenticates_WhenCachedTokenIsRejected()
    {
        var handler = new ReauthenticatingHandler();
        var client = CreateClient(handler);

        var results = await client.SearchTestsAsync(
            new XrayTestSearchRequest("project = QA", 10),
            CancellationToken.None);

        Assert.Single(results);
        Assert.Equal(2, handler.AuthenticateCalls);
        Assert.Equal(2, handler.GraphQlCalls);
    }

    [Fact]
    public async Task UpsertTestCaseAsync_UpdatesManualSteps_WithoutRemovingAllStepsFirst()
    {
        var handler = new ManualUpdateHandler();
        var client = CreateClient(handler);

        var result = await client.UpsertTestCaseAsync(
            new XrayTestCaseUpsertRequest(
                "RM",
                "manual test",
                "manual description",
                "Manual",
                null,
                [
                    new XrayTestStep("updated action 1", "updated data 1", "updated result 1"),
                    new XrayTestStep("updated action 2", "updated data 2", "updated result 2"),
                ],
                [],
                "20001"),
            CancellationToken.None);

        Assert.False(result.Created);
        Assert.Equal("RM-15999", result.IssueKey);
        Assert.DoesNotContain(handler.GraphQlRequests, body => body.Contains("removeAllTestSteps", StringComparison.Ordinal));
        Assert.Collection(
            handler.GraphQlRequests,
            body => Assert.Contains("updateTestType", body, StringComparison.Ordinal),
            body => Assert.Contains("GetTestSteps", body, StringComparison.Ordinal),
            body => Assert.Contains("updateTestStep", body, StringComparison.Ordinal),
            body => Assert.Contains("updateTestStep", body, StringComparison.Ordinal),
            body => Assert.Contains("removeTestStep", body, StringComparison.Ordinal));
    }

    private static XrayCloudApiClient CreateClient(HttpMessageHandler handler)
        => new(
            new StubHttpClientFactory(new HttpClient(handler)),
            Options.Create(new XrayOptions
            {
                BaseUrl = "https://xray.cloud.getxray.app/api/v2/",
                ClientId = "client-id",
                ClientSecret = "client-secret",
            }),
            NullLogger<XrayCloudApiClient>.Instance);

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

    private sealed class SearchTestsHandler : HttpMessageHandler
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
    }

    private sealed class ReauthenticatingHandler : HttpMessageHandler
    {
        public int AuthenticateCalls { get; private set; }

        public int GraphQlCalls { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri?.PathAndQuery ?? string.Empty;
            if (path.Contains("authenticate", StringComparison.OrdinalIgnoreCase))
            {
                AuthenticateCalls++;
                return Json(AuthenticateCalls == 1 ? "\"expired-token\"" : "\"fresh-token\"");
            }

            if (!path.Contains("graphql", StringComparison.OrdinalIgnoreCase))
            {
                return new HttpResponseMessage(HttpStatusCode.NotFound);
            }

            GraphQlCalls++;
            var token = request.Headers.Authorization?.Parameter;
            if (string.Equals(token, "expired-token", StringComparison.Ordinal))
            {
                return new HttpResponseMessage(HttpStatusCode.Unauthorized);
            }

            var requestBody = request.Content is null
                ? string.Empty
                : await request.Content.ReadAsStringAsync(cancellationToken);

            return requestBody.Contains("getExpandedTests", StringComparison.Ordinal)
                ? Json(
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
                    """)
                : new HttpResponseMessage(HttpStatusCode.BadRequest);
        }
    }

    private sealed class ManualUpdateHandler : HttpMessageHandler
    {
        public List<string> GraphQlRequests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri?.PathAndQuery ?? string.Empty;
            if (path.Contains("authenticate", StringComparison.OrdinalIgnoreCase))
            {
                return Json("\"manual-token\"");
            }

            if (!path.Contains("graphql", StringComparison.OrdinalIgnoreCase))
            {
                return new HttpResponseMessage(HttpStatusCode.NotFound);
            }

            var requestBody = request.Content is null
                ? string.Empty
                : await request.Content.ReadAsStringAsync(cancellationToken);
            GraphQlRequests.Add(requestBody);

            if (requestBody.Contains("updateTestType", StringComparison.Ordinal))
            {
                return Json(
                    """
                    {
                      "data": {
                        "updateTestType": {
                          "issueId": "20001",
                          "jira": {
                            "key": "RM-15999"
                          }
                        }
                      }
                    }
                    """);
            }

            if (requestBody.Contains("GetTestSteps", StringComparison.Ordinal))
            {
                return Json(
                    """
                    {
                      "data": {
                        "getTest": {
                          "steps": [
                            {
                              "id": "step-1",
                              "action": "old action 1",
                              "data": "old data 1",
                              "result": "old result 1"
                            },
                            {
                              "id": "step-2",
                              "action": "old action 2",
                              "data": "old data 2",
                              "result": "old result 2"
                            },
                            {
                              "id": "step-3",
                              "action": "old action 3",
                              "data": "old data 3",
                              "result": "old result 3"
                            }
                          ]
                        }
                      }
                    }
                    """);
            }

            if (requestBody.Contains("updateTestStep", StringComparison.Ordinal))
            {
                return Json(
                    """
                    {
                      "data": {
                        "updateTestStep": {
                          "warnings": []
                        }
                      }
                    }
                    """);
            }

            if (requestBody.Contains("removeTestStep", StringComparison.Ordinal))
            {
                return Json(
                    """
                    {
                      "data": {
                        "removeTestStep": "step-3"
                      }
                    }
                    """);
            }

            return new HttpResponseMessage(HttpStatusCode.BadRequest);
        }
    }

    private static HttpResponseMessage Json(string json)
        => new(HttpStatusCode.OK)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
}
