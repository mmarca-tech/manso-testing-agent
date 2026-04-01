using System.Net;
using System.Text;
using System.Text.Json;
using Manso.Application;
using Manso.Domain;
using Manso.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Manso.UnitTests;

public sealed class AzureDevOpsScmClientTests
{
    [Fact]
    public async Task GetCodeContextAsync_AggregatesMergedPullRequestDiffs_ForAutomationImplementation()
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
            "bank-otp-api",
            "AzureDevOps",
            "afs-dev",
            "rps",
            "bank-otp-api",
            "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api",
            "main",
            null,
            "main",
            null,
            null,
            null,
            null,
            "jira_development_merged_pull_request_aggregate")
        {
            PullRequestIds = [881, 882],
            PullRequestReferences =
            [
                "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/881",
                "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/882",
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
            "bank-otp-api",
            "AzureDevOps",
            "afs-dev",
            "rps",
            "bank-otp-api",
            "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api",
            "main",
            "feature/folder-skip",
            "main",
            883,
            "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/883",
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
        Assert.Equal("/src/Tests/Risk.Bank.Otp.FunctionalTests/RetryFlowTests.cs", change.Path);
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
            "bank-otp-api",
            "AzureDevOps",
            "afs-dev",
            "rps",
            "bank-otp-api",
            "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api",
            "main",
            "feature/qa-1234",
            "main",
            882,
            "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/882",
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

        Assert.Contains(result.NeighboringTests, test => test.Path == "/src/Tests/Risk.Bank.Otp.FunctionalTests/RetryFlowTests.cs");
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
            "bank-otp-api",
            "AzureDevOps",
            "afs-dev",
            "rps",
            "bank-otp-api",
            "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api",
            "main",
            "feature/settings-redaction",
            "main",
            884,
            "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/884",
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
    public async Task WriteAsync_CreatesBranchPushAndDraftPullRequest()
    {
        var handler = new StubHttpMessageHandler();
        var client = new AzureDevOpsScmClient(
            new StubHttpClientFactory(new HttpClient(handler)),
            Options.Create(new ScmOptions
            {
                Provider = "AzureDevOps",
                BaseUrl = "https://dev.azure.com/",
                ReadToken = "read-token",
                WriteToken = "write-token",
            }),
            NullLogger<AzureDevOpsScmClient>.Instance);

        var target = new RepositoryTarget(
            "bank-otp-api",
            "AzureDevOps",
            "afs-dev",
            "rps",
            "bank-otp-api",
            "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api",
            "main",
            "feature/qa-1234",
            "main",
            882,
            "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/882",
            "source-sha",
            "target-sha",
            "jira_development_pull_request");

        var result = await client.WriteAsync(
            target,
            new RepositoryWritePlan(
                "bank-otp-api",
                "main",
                "ai-testgen/QA-1234/retry-flow-tests",
                "test(ai): generate tests for QA-1234",
                [
                    new GeneratedFile(
                        "/tests/Callbacks/RetryHandlerTests.cs",
                        "public sealed class RetryHandlerTests { }",
                        GeneratedFileAction.Create),
                ],
                "[AI TestGen] QA-1234 - generated test updates",
                "AI-generated review content",
                true),
            CancellationToken.None);

        Assert.Equal("ai-testgen/QA-1234/retry-flow-tests", result.BranchName);
        Assert.Equal("generated-commit-sha", result.CommitId);
        Assert.Equal("https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/999", result.PullRequestUrl);

        Assert.NotNull(handler.LastPushRequestBody);
        using var pushJson = JsonDocument.Parse(handler.LastPushRequestBody!);
        Assert.Equal(
            "refs/heads/ai-testgen/QA-1234/retry-flow-tests",
            pushJson.RootElement.GetProperty("refUpdates")[0].GetProperty("name").GetString());
        Assert.Equal(
            "main-head-sha",
            pushJson.RootElement.GetProperty("refUpdates")[0].GetProperty("oldObjectId").GetString());

        Assert.NotNull(handler.LastPullRequestBody);
        using var pullRequestJson = JsonDocument.Parse(handler.LastPullRequestBody!);
        Assert.True(pullRequestJson.RootElement.GetProperty("isDraft").GetBoolean());
        Assert.Equal(
            "refs/heads/ai-testgen/QA-1234/retry-flow-tests",
            pullRequestJson.RootElement.GetProperty("sourceRefName").GetString());
        Assert.Equal(
            "refs/heads/main",
            pullRequestJson.RootElement.GetProperty("targetRefName").GetString());
    }

    private static RepositoryConventions CreateConventions()
        => new(
            "bank-otp-api",
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
        public string? LastPushRequestBody { get; private set; }

        public string? LastPullRequestBody { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var pathAndQuery = request.RequestUri?.PathAndQuery ?? string.Empty;
            var requestBody = request.Content is null
                ? null
                : request.Content.ReadAsStringAsync(cancellationToken).GetAwaiter().GetResult();

            if (pathAndQuery.Contains("/pushes?", StringComparison.OrdinalIgnoreCase))
            {
                LastPushRequestBody = requestBody;
            }

            if (pathAndQuery.Contains("/pullrequests?", StringComparison.OrdinalIgnoreCase))
            {
                LastPullRequestBody = requestBody;
            }

            return Task.FromResult(pathAndQuery switch
            {
                var value when value.Contains("/refs?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("filter=heads%2Fmain", StringComparison.OrdinalIgnoreCase)
                    => Json("""
                        {
                          "value": [
                            {
                              "name": "refs/heads/main",
                              "objectId": "main-head-sha"
                            }
                          ]
                        }
                        """),
                var value when value.Contains("/pushes?", StringComparison.OrdinalIgnoreCase)
                    => Json("""
                        {
                          "commits": [
                            {
                              "commitId": "generated-commit-sha"
                            }
                          ]
                        }
                        """),
                var value when value.Contains("/pullrequests?", StringComparison.OrdinalIgnoreCase)
                    => Json("""
                        {
                          "pullRequestId": 999,
                          "url": "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/999"
                        }
                        """),
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
                                "path": "/src/Tests/Risk.Bank.Otp.FunctionalTests",
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
                                "path": "/src/Tests/Risk.Bank.Otp.FunctionalTests/RetryFlowTests.cs"
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
                                value.Contains("path=%2Fsrc%2FTests%2FRisk.Bank.Otp.FunctionalTests%2FRetryFlowTests.cs", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("versionDescriptor.version=source-sha-folder", StringComparison.OrdinalIgnoreCase)
                    => Json("""{ "content": "public class RetryFlowTests { }" }"""),
                var value when value.Contains("/items?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("path=%2Fsrc%2FPayments%2FRetryHandler.cs", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("versionDescriptor.version=source-sha&", StringComparison.OrdinalIgnoreCase)
                    => Json("""{ "content": "return true;" }"""),
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
                              "path": "/src/Tests/Risk.Bank.Otp.FunctionalTests/RetryFlowTests.cs",
                              "isFolder": false
                            }
                          ]
                        }
                        """),
                var value when value.Contains("/items?", StringComparison.OrdinalIgnoreCase) &&
                                value.Contains("path=%2Fsrc%2FTests%2FRisk.Bank.Otp.FunctionalTests%2FRetryFlowTests.cs", StringComparison.OrdinalIgnoreCase) &&
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
