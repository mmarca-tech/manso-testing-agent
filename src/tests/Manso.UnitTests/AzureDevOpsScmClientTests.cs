using Manso.Application;
using Manso.Domain;
using Manso.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using System.Net;
using System.Text;

namespace Manso.UnitTests;

public sealed class AzureDevOpsScmClientTests
{
    [Fact]
    public async Task GetCodeContextAsync_AggregatesPullRequestDiffs()
    {
        var client = new AzureDevOpsScmClient(
            new StubHttpClientFactory(new HttpClient(new StubHttpMessageHandler())),
            Options.Create(new ScmOptions
            {
                Provider = "AzureDevOps",
                BaseUrl = "https://dev.azure.com/",
                ReadToken = "test-token",
            }),
            NullLogger<AzureDevOpsScmClient>.Instance);

        var target = new RepositoryTarget(
            "SomeRepo",
            "AzureDevOps",
            "SomeProject",
            "SomeTeam",
            "SomeRepo",
            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo",
            "main",
            null,
            "main",
            null,
            null,
            null,
            null,
            "jira_development_pull_request_aggregate")
        {
            PullRequestIds = [881, 882],
            PullRequestReferences =
            [
                "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/881",
                "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/882",
            ],
        };

        var result = await client.GetCodeContextAsync(
            target,
            new RepositoryRetrievalOptions
            {
                MaxChangedFiles = 10,
                MaxDiffLinesPerFile = 40,
                MaxNeighboringTests = 0,
            },
            CreateConventions(),
            CancellationToken.None);

        var change = Assert.Single(result.ChangedFiles);
        Assert.Equal("/src/Payments/RetryHandler.cs", change.Path);
        Assert.Contains("pullrequest/881", change.DiffPreview);
        Assert.Contains("pullrequest/882", change.DiffPreview);
        Assert.Empty(result.NeighboringTests);
        Assert.True(result.ProviderRequestCount > 0);
    }

    [Fact]
    public async Task GetCodeContextAsync_SkipsFolders_WithoutConsumingChangedFileLimit()
    {
        var client = new AzureDevOpsScmClient(
            new StubHttpClientFactory(new HttpClient(new StubHttpMessageHandler())),
            Options.Create(new ScmOptions
            {
                Provider = "AzureDevOps",
                BaseUrl = "https://dev.azure.com/",
                ReadToken = "test-token",
            }),
            NullLogger<AzureDevOpsScmClient>.Instance);

        var target = new RepositoryTarget(
            "SomeRepo",
            "AzureDevOps",
            "SomeProject",
            "SomeTeam",
            "SomeRepo",
            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo",
            "main",
            "feature/folder-skip",
            "main",
            883,
            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/883",
            "source-sha-folder",
            "target-sha-folder",
            "jira_development_pull_request");

        var result = await client.GetCodeContextAsync(
            target,
            new RepositoryRetrievalOptions
            {
                MaxChangedFiles = 1,
                MaxDiffLinesPerFile = 40,
                MaxNeighboringTests = 0,
            },
            CreateConventions(),
            CancellationToken.None);

        var change = Assert.Single(result.ChangedFiles);
        Assert.Equal("/src/Tests/Application.FunctionalTests/RetryFlowTests.cs", change.Path);
        Assert.DoesNotContain(result.Warnings, warning => warning.Code == "folder_change_skipped");
        Assert.DoesNotContain(result.Warnings, warning => warning.Code == "changed_files_truncated");
    }

    [Fact]
    public async Task GetCodeContextAsync_UsesAdapterConfiguredTestRoots_WhenFindingNeighboringTests()
    {
        var client = new AzureDevOpsScmClient(
            new StubHttpClientFactory(new HttpClient(new StubHttpMessageHandler())),
            Options.Create(new ScmOptions
            {
                Provider = "AzureDevOps",
                BaseUrl = "https://dev.azure.com/",
                ReadToken = "test-token",
            }),
            NullLogger<AzureDevOpsScmClient>.Instance);

        var target = new RepositoryTarget(
            "SomeRepo",
            "AzureDevOps",
            "SomeProject",
            "SomeTeam",
            "SomeRepo",
            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo",
            "main",
            "feature/qa-1234",
            "main",
            882,
            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/882",
            "source-sha",
            "target-sha",
            "jira_development_pull_request");

        var result = await client.GetCodeContextAsync(
            target,
            new RepositoryRetrievalOptions
            {
                MaxChangedFiles = 10,
                MaxDiffLinesPerFile = 40,
                MaxNeighboringTests = 5,
                MaxNeighboringTestLines = 20,
            },
            CreateConventions(),
            CancellationToken.None);

        Assert.Contains(result.NeighboringTests, test => test.Path == "/src/Tests/Application.FunctionalTests/RetryFlowTests.cs");
    }

    [Fact]
    public async Task GetCodeContextAsync_RedactsSensitiveValues_FromSettingsDiffs()
    {
        var client = new AzureDevOpsScmClient(
            new StubHttpClientFactory(new HttpClient(new StubHttpMessageHandler())),
            Options.Create(new ScmOptions
            {
                Provider = "AzureDevOps",
                BaseUrl = "https://dev.azure.com/",
                ReadToken = "test-token",
            }),
            NullLogger<AzureDevOpsScmClient>.Instance);

        var target = new RepositoryTarget(
            "SomeRepo",
            "AzureDevOps",
            "SomeProject",
            "SomeTeam",
            "SomeRepo",
            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo",
            "main",
            "feature/settings-redaction",
            "main",
            884,
            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/884",
            "source-sha-settings",
            "target-sha-settings",
            "jira_development_pull_request");

        var result = await client.GetCodeContextAsync(
            target,
            new RepositoryRetrievalOptions
            {
                MaxChangedFiles = 10,
                MaxDiffLinesPerFile = 40,
                MaxNeighboringTests = 0,
            },
            CreateConventions(),
            CancellationToken.None);

        var change = Assert.Single(result.ChangedFiles);
        Assert.Equal("/settings/Default/Default.yaml", change.Path);
        Assert.NotNull(change.DiffPreview);
        Assert.Contains("[REDACTED]", change.DiffPreview, StringComparison.Ordinal);
        Assert.DoesNotContain("old-super-secret-value", change.DiffPreview, StringComparison.Ordinal);
        Assert.DoesNotContain("new-super-secret-value", change.DiffPreview, StringComparison.Ordinal);
    }

    [Fact]
    public async Task GetRepositoryFilesAsync_FetchesOnlyExistingRequestedFiles()
    {
        var client = new AzureDevOpsScmClient(
            new StubHttpClientFactory(new HttpClient(new StubHttpMessageHandler())),
            Options.Create(new ScmOptions
            {
                Provider = "AzureDevOps",
                BaseUrl = "https://dev.azure.com/",
                ReadToken = "test-token",
            }),
            NullLogger<AzureDevOpsScmClient>.Instance);

        var target = new RepositoryTarget(
            "SomeRepo",
            "AzureDevOps",
            "SomeProject",
            "SomeTeam",
            "SomeRepo",
            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo",
            "main",
            "feature/qa-1234",
            "main",
            882,
            "https://dev.azure.com/SomeProject/SomeTeam/_git/SomeRepo/pullrequest/882",
            "source-sha",
            "target-sha",
            "jira_development_pull_request");

        var files = await client.GetRepositoryFilesAsync(
            target,
            [
                RepositoryGuidancePaths.TestArchitecture,
                RepositoryGuidancePaths.RepoConventions,
                "/docs/testing/missing.md",
            ],
            CancellationToken.None);

        Assert.Equal(2, files.Count);
        Assert.Contains(files, file => file.Path == RepositoryGuidancePaths.TestArchitecture);
        Assert.Contains(files, file => file.Path == RepositoryGuidancePaths.RepoConventions);
        Assert.Contains("fixture-per-feature", files.Single(file => file.Path == RepositoryGuidancePaths.TestArchitecture).Content);
        Assert.Contains("supportsExecutableTestGeneration", files.Single(file => file.Path == RepositoryGuidancePaths.RepoConventions).Content);
    }

    private static RepositoryConventions CreateConventions()
        => new(
            "SomeRepo",
            false,
            "xUnit",
            ".NET 10",
            ["/tests", "/src/Tests"],
            ["/tests/helpers"],
            ["/src"],
            ["dotnet build src/Manso.sln"],
            ["dotnet test src/Manso.sln"],
            ["dotnet format src/Manso.sln --verify-no-changes"],
            "Tests.cs");

    private sealed class StubHttpClientFactory : IHttpClientFactory
    {
        private readonly HttpClient _client;

        public StubHttpClientFactory(HttpClient client)
        {
            _client = client;
            _client.BaseAddress = new Uri("https://dev.azure.com/");
        }

        public HttpClient CreateClient(string name) => _client;
    }

    private sealed class StubHttpMessageHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var pathAndQuery = request.RequestUri?.PathAndQuery ?? string.Empty;

            return Task.FromResult(pathAndQuery switch
            {
                var value when value.Contains("/pullRequests/881?", StringComparison.OrdinalIgnoreCase)
                    => Json("""
                        {
                          "pullRequestId": 881,
                          "sourceRefName": "refs/heads/feature/rm-15888-a",
                          "targetRefName": "refs/heads/main",
                          "lastMergeSourceCommit": { "commitId": "source-sha-1" },
                          "lastMergeTargetCommit": { "commitId": "target-sha-1" },
                          "status": "completed"
                        }
                        """),
                var value when value.Contains("/pullRequests/882?", StringComparison.OrdinalIgnoreCase)
                    => Json("""
                        {
                          "pullRequestId": 882,
                          "sourceRefName": "refs/heads/feature/rm-15888-b",
                          "targetRefName": "refs/heads/main",
                          "lastMergeSourceCommit": { "commitId": "source-sha-2" },
                          "lastMergeTargetCommit": { "commitId": "target-sha-2" },
                          "status": "completed"
                        }
                        """),
                var value when value.Contains("/pullRequests/883?", StringComparison.OrdinalIgnoreCase)
                    => Json("""
                        {
                          "pullRequestId": 883,
                          "sourceRefName": "refs/heads/feature/folder-skip",
                          "targetRefName": "refs/heads/main",
                          "lastMergeSourceCommit": { "commitId": "source-sha-folder" },
                          "lastMergeTargetCommit": { "commitId": "target-sha-folder" },
                          "status": "active"
                        }
                        """),
                var value when value.Contains("/pullRequests/884?", StringComparison.OrdinalIgnoreCase)
                    => Json("""
                        {
                          "pullRequestId": 884,
                          "sourceRefName": "refs/heads/feature/settings-redaction",
                          "targetRefName": "refs/heads/main",
                          "lastMergeSourceCommit": { "commitId": "source-sha-settings" },
                          "lastMergeTargetCommit": { "commitId": "target-sha-settings" },
                          "status": "active"
                        }
                        """),
                var value when value.Contains("/diffs/commits?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("baseVersion=target-sha-1", StringComparison.OrdinalIgnoreCase)
                    => Json("""
                        {
                          "allChangesIncluded": true,
                          "changes": [
                            {
                              "changeType": "edit",
                              "item": { "path": "/src/Payments/RetryHandler.cs" }
                            }
                          ]
                        }
                        """),
                var value when value.Contains("/diffs/commits?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("baseVersion=target-sha-2", StringComparison.OrdinalIgnoreCase)
                    => Json("""
                        {
                          "allChangesIncluded": true,
                          "changes": [
                            {
                              "changeType": "edit",
                              "item": { "path": "/src/Payments/RetryHandler.cs" }
                            }
                          ]
                        }
                        """),
                var value when value.Contains("/diffs/commits?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("baseVersion=target-sha-folder", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("$skip=0", StringComparison.OrdinalIgnoreCase)
                    => Json("""
                        {
                          "allChangesIncluded": false,
                          "changes": [
                            {
                              "changeType": "add",
                              "item": {
                                "path": "/src/Tests/Application.FunctionalTests",
                                "isFolder": true
                              }
                            }
                          ]
                        }
                        """),
                var value when value.Contains("/diffs/commits?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("baseVersion=target-sha-folder", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("$skip=1", StringComparison.OrdinalIgnoreCase)
                    => Json("""
                        {
                          "allChangesIncluded": true,
                          "changes": [
                            {
                              "changeType": "add",
                              "item": {
                                "path": "/src/Tests/Application.FunctionalTests/RetryFlowTests.cs"
                              }
                            }
                          ]
                        }
                        """),
                var value when value.Contains("/diffs/commits?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("baseVersion=target-sha&", StringComparison.OrdinalIgnoreCase)
                    => Json("""
                        {
                          "allChangesIncluded": true,
                          "changes": [
                            {
                              "changeType": "edit",
                              "item": { "path": "/src/Payments/RetryHandler.cs" }
                            }
                          ]
                        }
                        """),
                var value when value.Contains("/diffs/commits?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("baseVersion=target-sha-settings", StringComparison.OrdinalIgnoreCase)
                    => Json("""
                        {
                          "allChangesIncluded": true,
                          "changes": [
                            {
                              "changeType": "edit",
                              "item": { "path": "/settings/Default/Default.yaml" }
                            }
                          ]
                        }
                        """),
                var value when value.Contains("/items?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("path=%2Fsrc%2FPayments%2FRetryHandler.cs", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("versionDescriptor.version=target-sha-1", StringComparison.OrdinalIgnoreCase)
                    => Json("""{ "content": "return false;" }"""),
                var value when value.Contains("/items?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("path=%2Fsrc%2FPayments%2FRetryHandler.cs", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("versionDescriptor.version=source-sha-1", StringComparison.OrdinalIgnoreCase)
                    => Json("""{ "content": "return true;" }"""),
                var value when value.Contains("/items?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("path=%2Fsrc%2FPayments%2FRetryHandler.cs", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("versionDescriptor.version=target-sha-2", StringComparison.OrdinalIgnoreCase)
                    => Json("""{ "content": "return true;" }"""),
                var value when value.Contains("/items?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("path=%2Fsrc%2FPayments%2FRetryHandler.cs", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("versionDescriptor.version=source-sha-2", StringComparison.OrdinalIgnoreCase)
                    => Json("""{ "content": "SaveResult(); return true;" }"""),
                var value when value.Contains("/items?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("path=%2Fsrc%2FTests%2FApplication.FunctionalTests%2FRetryFlowTests.cs", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("versionDescriptor.version=source-sha-folder", StringComparison.OrdinalIgnoreCase)
                    => Json("""{ "content": "public class RetryFlowTests { }" }"""),
                var value when value.Contains("/items?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("path=%2Fsrc%2FPayments%2FRetryHandler.cs", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("versionDescriptor.version=source-sha&", StringComparison.OrdinalIgnoreCase)
                    => Json("""{ "content": "return true;" }"""),
                var value when value.Contains("/items?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("path=%2Farchitecture%2Ftest-architecture.md", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("versionDescriptor.version=source-sha&", StringComparison.OrdinalIgnoreCase)
                    => Json("""{ "content": "Use fixture-per-feature tests." }"""),
                var value when value.Contains("/items?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("path=%2F.manso%2Frepo-conventions.json", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("versionDescriptor.version=source-sha&", StringComparison.OrdinalIgnoreCase)
                    => Json(
                        """
                        {
                          "content": "{ \"supportsExecutableTestGeneration\": true }"
                        }
                        """),
                var value when value.Contains("/items?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("path=%2Fsrc%2FPayments%2FRetryHandler.cs", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("versionDescriptor.version=target-sha&", StringComparison.OrdinalIgnoreCase)
                    => Json("""{ "content": "return false;" }"""),
                var value when value.Contains("/items?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("path=%2Fsettings%2FDefault%2FDefault.yaml", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("versionDescriptor.version=target-sha-settings", StringComparison.OrdinalIgnoreCase)
                    => Json("""
                        {
                          "content": "ClientSecret:\n  value: new-super-secret-value\nBAG_API_KEY:\n  value: abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH\n"
                        }
                        """),
                var value when value.Contains("/items?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("path=%2Fsettings%2FDefault%2FDefault.yaml", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("versionDescriptor.version=source-sha-settings", StringComparison.OrdinalIgnoreCase)
                    => Json("""
                        {
                          "content": "ClientSecret:\n  value: old-super-secret-value\nBAG_API_KEY:\n  value: 1234567890abcdefghijklmnopqrstuvwxyzABCDEFGH\n"
                        }
                        """),
                var value when value.Contains("/items?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("scopePath=%2Fsrc%2FTests", StringComparison.OrdinalIgnoreCase)
                    => Json("""
                        {
                          "value": [
                            {
                              "path": "/src/Tests/Application.FunctionalTests/RetryFlowTests.cs",
                              "isFolder": false
                            }
                          ]
                        }
                        """),
                var value when value.Contains("/items?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("path=%2Fsrc%2FTests%2FApplication.FunctionalTests%2FRetryFlowTests.cs", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("versionDescriptor.version=source-sha", StringComparison.OrdinalIgnoreCase)
                    => Json("""{ "content": "public class RetryFlowTests { [Fact] public void Existing() { } }" }"""),
                var value when value.Contains("/items?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("scopePath=", StringComparison.OrdinalIgnoreCase)
                    => Json("""{ "value": [] }"""),
                _
                    => new HttpResponseMessage(HttpStatusCode.NotFound)
            });
        }

        private static HttpResponseMessage Json(string json)
            => new(HttpStatusCode.OK)
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json"),
            };
    }
}
