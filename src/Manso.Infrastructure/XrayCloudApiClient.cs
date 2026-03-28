using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Manso.Infrastructure;

public sealed class XrayCloudApiClient : IXrayApiClient
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IOptions<XrayOptions> _options;
    private readonly ILogger<XrayCloudApiClient> _logger;
    private string? _cachedToken;

    public XrayCloudApiClient(
        IHttpClientFactory httpClientFactory,
        IOptions<XrayOptions> options,
        ILogger<XrayCloudApiClient> logger)
    {
        _httpClientFactory = httpClientFactory;
        _options = options;
        _logger = logger;
    }

    public Task<XrayTestCaseUpsertResult> UpsertTestCaseAsync(
        XrayTestCaseUpsertRequest request,
        CancellationToken ct)
        => request.ExistingIssueId is null
            ? CreateTestCaseAsync(request, ct)
            : UpdateTestCaseAsync(request, ct);

    public Task<XrayTestExecutionUploadResult> UploadExecutionAsync(
        XrayTestExecutionUploadRequest request,
        CancellationToken ct)
        => throw new NotImplementedException("Xray execution upload will be implemented after test case sync.");

    public Task AddTestsToTestPlanAsync(
        XrayAssociationUpdateRequest request,
        CancellationToken ct)
        => throw new NotImplementedException("Xray test plan updates will be implemented after test case sync.");

    public Task AddTestsToTestSetAsync(
        XrayAssociationUpdateRequest request,
        CancellationToken ct)
        => throw new NotImplementedException("Xray test set updates will be implemented after test case sync.");

    public async Task<IReadOnlyList<XrayTestCase>> SearchTestsAsync(
        XrayTestSearchRequest request,
        CancellationToken ct)
    {
        using var document = await SendGraphQlAsync(
            """
            query GetExpandedTests($jql: String!, $limit: Int!, $start: Int!) {
              getExpandedTests(jql: $jql, limit: $limit, start: $start) {
                results {
                  issueId
                  testType {
                    name
                  }
                  gherkin
                  steps {
                    action
                    data
                    result
                  }
                  jira(fields: ["key", "summary", "labels"])
                }
              }
            }
            """,
            new
            {
                jql = request.Jql,
                limit = request.Limit,
                start = 0,
            },
            ct);

        if (!TryGetPath(
                document.RootElement,
                out var resultsElement,
                "data",
                "getExpandedTests",
                "results") ||
            resultsElement.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<XrayTestCase>();
        }

        return resultsElement.EnumerateArray()
            .Select(MapTestCase)
            .Where(test => !string.IsNullOrWhiteSpace(test.IssueId))
            .ToArray();
    }

    private async Task<XrayTestCaseUpsertResult> CreateTestCaseAsync(
        XrayTestCaseUpsertRequest request,
        CancellationToken ct)
    {
        using var document = await SendGraphQlAsync(
            """
            mutation CreateTest($testType: UpdateTestTypeInput, $steps: [CreateStepInput], $unstructured: String, $gherkin: String, $jira: JSON!) {
              createTest(testType: $testType, steps: $steps, unstructured: $unstructured, gherkin: $gherkin, jira: $jira) {
                test {
                  issueId
                  jira(fields: ["key"])
                }
                warnings
              }
            }
            """,
            new
            {
                testType = new { name = request.TestType },
                steps = request.TestType.Equals("Manual", StringComparison.OrdinalIgnoreCase) ? request.Steps.Select(step => new
                {
                    action = step.Action,
                    data = step.Data,
                    result = step.Result,
                }).ToArray() : null,
                unstructured = request.TestType.Equals("Generic", StringComparison.OrdinalIgnoreCase)
                    ? request.Description
                    : null,
                gherkin = request.TestType.Equals("Cucumber", StringComparison.OrdinalIgnoreCase)
                    ? request.Gherkin
                    : null,
                jira = new
                {
                    fields = new
                    {
                        summary = request.Summary,
                        description = request.Description,
                        project = new { key = request.ProjectKey },
                        labels = request.Labels,
                    },
                },
            },
            ct);

        if (!TryGetPath(document.RootElement, out var testElement, "data", "createTest", "test"))
        {
            throw new InvalidOperationException("Xray createTest response did not include the created test payload.");
        }

        return new XrayTestCaseUpsertResult(
            testElement.TryGetProperty("issueId", out var issueIdElement) ? issueIdElement.GetString() ?? string.Empty : string.Empty,
            ExtractIssueKey(testElement),
            true);
    }

    private async Task<XrayTestCaseUpsertResult> UpdateTestCaseAsync(
        XrayTestCaseUpsertRequest request,
        CancellationToken ct)
    {
        var issueId = request.ExistingIssueId
                      ?? throw new InvalidOperationException("ExistingIssueId is required for Xray test updates.");

        await SendGraphQlAsync(
            """
            mutation UpdateTestType($issueId: String!, $testType: UpdateTestTypeInput!) {
              updateTestType(issueId: $issueId, testType: $testType) {
                issueId
                jira(fields: ["key"])
              }
            }
            """,
            new
            {
                issueId,
                testType = new { name = request.TestType },
            },
            ct);

        if (request.TestType.Equals("Cucumber", StringComparison.OrdinalIgnoreCase))
        {
            using var document = await SendGraphQlAsync(
                """
                mutation UpdateGherkin($issueId: String!, $gherkin: String!) {
                  updateGherkinTestDefinition(issueId: $issueId, gherkin: $gherkin) {
                    issueId
                    jira(fields: ["key"])
                  }
                }
                """,
                new
                {
                    issueId,
                    gherkin = request.Gherkin ?? string.Empty,
                },
                ct);

            return new XrayTestCaseUpsertResult(issueId, ExtractIssueKey(document.RootElement.GetProperty("data").GetProperty("updateGherkinTestDefinition")), false);
        }

        if (request.TestType.Equals("Manual", StringComparison.OrdinalIgnoreCase))
        {
            await SendGraphQlAsync(
                """
                mutation RemoveAllSteps($issueId: String!) {
                  removeAllTestSteps(issueId: $issueId)
                }
                """,
                new { issueId },
                ct);

            foreach (var step in request.Steps)
            {
                await SendGraphQlAsync(
                    """
                    mutation AddStep($issueId: String!, $step: CreateStepInput!) {
                      addTestStep(issueId: $issueId, step: $step) {
                        issueId
                        jira(fields: ["key"])
                      }
                    }
                    """,
                    new
                    {
                        issueId,
                        step = new
                        {
                            action = step.Action,
                            data = step.Data,
                            result = step.Result,
                        },
                    },
                    ct);
            }

            return new XrayTestCaseUpsertResult(issueId, string.Empty, false);
        }

        using (var document = await SendGraphQlAsync(
                   """
                   mutation UpdateUnstructured($issueId: String!, $unstructured: String!) {
                     updateUnstructuredTestDefinition(issueId: $issueId, unstructured: $unstructured) {
                       issueId
                       jira(fields: ["key"])
                     }
                   }
                   """,
                   new
                   {
                       issueId,
                       unstructured = request.Description,
                   },
                   ct))
        {
            return new XrayTestCaseUpsertResult(issueId, ExtractIssueKey(document.RootElement.GetProperty("data").GetProperty("updateUnstructuredTestDefinition")), false);
        }
    }

    private async Task<HttpRequestMessage> CreateGraphQlRequestAsync(string jsonBody, CancellationToken ct)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "graphql");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await GetAccessTokenAsync(ct));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
        return request;
    }

    private async Task<string> GetAccessTokenAsync(CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(_cachedToken))
        {
            return _cachedToken;
        }

        var payload = JsonSerializer.Serialize(new
        {
            client_id = _options.Value.ClientId,
            client_secret = _options.Value.ClientSecret,
        });

        using var request = new HttpRequestMessage(HttpMethod.Post, "authenticate")
        {
            Content = new StringContent(payload, Encoding.UTF8, "application/json"),
        };

        var client = _httpClientFactory.CreateClient("XrayApi");
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();

        var raw = (await response.Content.ReadAsStringAsync(ct)).Trim();
        if (raw.StartsWith("\"", StringComparison.Ordinal) && raw.EndsWith("\"", StringComparison.Ordinal))
        {
            _cachedToken = JsonSerializer.Deserialize<string>(raw);
        }
        else
        {
            using var document = JsonDocument.Parse(raw);
            _cachedToken = document.RootElement.TryGetProperty("token", out var tokenElement)
                ? tokenElement.GetString()
                : null;
        }

        if (string.IsNullOrWhiteSpace(_cachedToken))
        {
            throw new InvalidOperationException("Xray authentication succeeded but returned no access token.");
        }

        return _cachedToken;
    }

    private async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        _logger.LogInformation("Calling Xray API {Method} {Path}.", request.Method, request.RequestUri);
        var client = _httpClientFactory.CreateClient("XrayApi");
        return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
    }

    private async Task<JsonDocument> SendGraphQlAsync(
        string query,
        object variables,
        CancellationToken ct)
    {
        var payload = JsonSerializer.Serialize(new
        {
            query,
            variables,
        });

        using var request = await CreateGraphQlRequestAsync(payload, ct);
        using var response = await SendAsync(request, ct);
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            throw new InvalidOperationException($"Xray request was rejected with status {(int)response.StatusCode}.");
        }

        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        var document = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        ThrowIfGraphQlErrors(document.RootElement);
        return document;
    }

    private static XrayTestCase MapTestCase(JsonElement element)
    {
        var jiraFields = TryReadJiraFields(element);
        var labels = jiraFields.TryGetProperty("labels", out var labelsElement) &&
                     labelsElement.ValueKind == JsonValueKind.Array
            ? labelsElement.EnumerateArray()
                .Select(label => label.GetString())
                .Where(label => !string.IsNullOrWhiteSpace(label))
                .Cast<string>()
                .ToArray()
            : Array.Empty<string>();

        var steps = element.TryGetProperty("steps", out var stepsElement) &&
                    stepsElement.ValueKind == JsonValueKind.Array
            ? stepsElement.EnumerateArray()
                .Select(step => new XrayTestStep(
                    step.TryGetProperty("action", out var actionElement) ? actionElement.GetString() ?? string.Empty : string.Empty,
                    step.TryGetProperty("data", out var dataElement) ? dataElement.GetString() : null,
                    step.TryGetProperty("result", out var resultElement) ? resultElement.GetString() : null))
                .Where(step => !string.IsNullOrWhiteSpace(step.Action))
                .ToArray()
            : Array.Empty<XrayTestStep>();

        return new XrayTestCase(
            element.TryGetProperty("issueId", out var issueIdElement) ? issueIdElement.GetString() ?? string.Empty : string.Empty,
            jiraFields.TryGetProperty("key", out var keyElement) ? keyElement.GetString() ?? string.Empty : string.Empty,
            jiraFields.TryGetProperty("summary", out var summaryElement) ? summaryElement.GetString() ?? string.Empty : string.Empty,
            element.TryGetProperty("testType", out var testTypeElement) &&
            testTypeElement.ValueKind == JsonValueKind.Object &&
            testTypeElement.TryGetProperty("name", out var testTypeNameElement)
                ? testTypeNameElement.GetString() ?? string.Empty
                : string.Empty,
            element.TryGetProperty("gherkin", out var gherkinElement) ? gherkinElement.GetString() : null,
            steps,
            labels);
    }

    private static JsonElement TryReadJiraFields(JsonElement element)
    {
        if (!element.TryGetProperty("jira", out var jiraElement))
        {
            return default;
        }

        if (jiraElement.ValueKind == JsonValueKind.Object)
        {
            return jiraElement;
        }

        if (jiraElement.ValueKind == JsonValueKind.String &&
            !string.IsNullOrWhiteSpace(jiraElement.GetString()))
        {
            using var document = JsonDocument.Parse(jiraElement.GetString()!);
            return document.RootElement.Clone();
        }

        return default;
    }

    private static void ThrowIfGraphQlErrors(JsonElement root)
    {
        if (!root.TryGetProperty("errors", out var errorsElement) ||
            errorsElement.ValueKind != JsonValueKind.Array ||
            errorsElement.GetArrayLength() == 0)
        {
            return;
        }

        var messages = errorsElement.EnumerateArray()
            .Select(error => error.TryGetProperty("message", out var messageElement)
                ? messageElement.GetString()
                : null)
            .Where(message => !string.IsNullOrWhiteSpace(message))
            .Cast<string>()
            .ToArray();

        throw new InvalidOperationException(
            $"Xray GraphQL request returned errors: {string.Join(" | ", messages)}");
    }

    private static bool TryGetPath(JsonElement root, out JsonElement current, params string[] path)
    {
        current = root;
        foreach (var segment in path)
        {
            if (!current.TryGetProperty(segment, out current))
            {
                return false;
            }
        }

        return true;
    }

    private static string ExtractIssueKey(JsonElement testElement)
    {
        var jiraFields = TryReadJiraFields(testElement);
        return jiraFields.TryGetProperty("key", out var keyElement)
            ? keyElement.GetString() ?? string.Empty
            : string.Empty;
    }
}
