using System.Net;
using System.Text;
using System.Text.Json;
using Manso.Application;
using Manso.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Manso.UnitTests;

public sealed class OpenAiLlmGatewayTests
{
    [Fact]
    public async Task CompleteJsonAsync_UsesReasoningModelPayload_ForGpt5Models()
    {
        var handler = new CapturingHttpMessageHandler();
        var gateway = CreateGateway(handler, "gpt-5-mini");

        await gateway.CompleteJsonAsync(
            new LlmPromptRequest("system prompt", "user prompt", null),
            CancellationToken.None);

        var payload = ParseCapturedPayload(handler);
        Assert.Equal("gpt-5-mini", payload.GetProperty("model").GetString());
        Assert.Equal(4000, payload.GetProperty("max_completion_tokens").GetInt32());
        Assert.False(payload.TryGetProperty("max_tokens", out _));
        Assert.False(payload.TryGetProperty("temperature", out _));
    }

    [Fact]
    public async Task CompleteJsonAsync_UsesResponsesApiPayload_ForProModels()
    {
        var handler = new CapturingHttpMessageHandler
        {
            ResponseFactory = _ => new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    """{"output_text":"{\"scenarios\":[]}"}""",
                    Encoding.UTF8,
                    "application/json"),
            },
        };
        var gateway = CreateGateway(handler, "gpt-5.4-pro");

        var result = await gateway.CompleteJsonAsync(
            new LlmPromptRequest("system prompt", "user prompt", null),
            CancellationToken.None);

        var payload = ParseCapturedPayload(handler);
        Assert.NotNull(handler.CapturedRequestPath);
        Assert.EndsWith("responses", handler.CapturedRequestPath, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("gpt-5.4-pro", payload.GetProperty("model").GetString());
        Assert.Equal("system prompt", payload.GetProperty("instructions").GetString());
        Assert.Equal("user prompt", payload.GetProperty("input").GetString());
        Assert.Equal(4000, payload.GetProperty("max_output_tokens").GetInt32());
        Assert.Equal("json_object", payload.GetProperty("text").GetProperty("format").GetProperty("type").GetString());
        Assert.False(payload.TryGetProperty("messages", out _));
        Assert.Equal("{\"scenarios\":[]}", result.JsonOutput);
    }

    [Fact]
    public async Task CompleteJsonAsync_PollsBackgroundResponsesUntilCompleted_ForProModels()
    {
        var pollCount = 0;
        var handler = new CapturingHttpMessageHandler
        {
            ResponseFactory = request =>
            {
                if (request.Method == HttpMethod.Post &&
                    request.RequestUri?.OriginalString?.EndsWith("responses", StringComparison.OrdinalIgnoreCase) == true)
                {
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent(
                            """{"id":"resp_123","status":"queued"}""",
                            Encoding.UTF8,
                            "application/json"),
                    };
                }

                pollCount++;
                var pollBody = pollCount == 1
                    ? """{"id":"resp_123","status":"in_progress"}"""
                    : """{"id":"resp_123","status":"completed","output_text":"{\"scenarios\":[]}"}""";

                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(pollBody, Encoding.UTF8, "application/json"),
                };
            },
        };
        var gateway = CreateGateway(handler, "gpt-5.4-pro");

        var result = await gateway.CompleteJsonAsync(
            new LlmPromptRequest("system prompt", "user prompt", null),
            CancellationToken.None);

        Assert.Equal("{\"scenarios\":[]}", result.JsonOutput);
        Assert.Equal(3, handler.RequestPaths.Count);
        Assert.EndsWith("responses", handler.RequestPaths[0], StringComparison.OrdinalIgnoreCase);
        Assert.EndsWith("responses/resp_123", handler.RequestPaths[1], StringComparison.OrdinalIgnoreCase);
        Assert.EndsWith("responses/resp_123", handler.RequestPaths[2], StringComparison.OrdinalIgnoreCase);

        var payload = ParseCapturedPayload(handler);
        Assert.True(payload.GetProperty("background").GetBoolean());
    }

    [Fact]
    public async Task CompleteJsonAsync_ThrowsHelpfulError_WhenBackgroundResponseFails()
    {
        var handler = new CapturingHttpMessageHandler
        {
            ResponseFactory = request =>
            {
                var responseBody = request.Method == HttpMethod.Post
                    ? """{"id":"resp_123","status":"queued"}"""
                    : """{"id":"resp_123","status":"failed","error":{"message":"model overloaded"}}""";

                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(responseBody, Encoding.UTF8, "application/json"),
                };
            },
        };
        var gateway = CreateGateway(handler, "gpt-5.4-pro");

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            gateway.CompleteJsonAsync(
                new LlmPromptRequest("system prompt", "user prompt", null),
                CancellationToken.None));

        Assert.Contains("status 'failed'", exception.Message, StringComparison.Ordinal);
        Assert.Contains("model overloaded", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CompleteJsonAsync_ThrowsTimeout_WhenBackgroundResponseExceedsConfiguredLimit()
    {
        var handler = new CapturingHttpMessageHandler
        {
            ResponseFactory = request =>
            {
                var responseBody = request.Method == HttpMethod.Post
                    ? """{"id":"resp_123","status":"queued"}"""
                    : """{"id":"resp_123","status":"queued"}""";

                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(responseBody, Encoding.UTF8, "application/json"),
                };
            },
        };
        var gateway = CreateGateway(handler, "gpt-5.4-pro", requestTimeoutSeconds: 1);

        var exception = await Assert.ThrowsAsync<TimeoutException>(() =>
            gateway.CompleteJsonAsync(
                new LlmPromptRequest("system prompt", "user prompt", null),
                CancellationToken.None));

        Assert.Contains("configured timeout of 1 second", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CompleteJsonAsync_UsesLegacyChatCompletionsPayload_ForNonReasoningModels()
    {
        var handler = new CapturingHttpMessageHandler();
        var gateway = CreateGateway(handler, "gpt-4o-mini");

        await gateway.CompleteJsonAsync(
            new LlmPromptRequest("system prompt", "user prompt", null),
            CancellationToken.None);

        var payload = ParseCapturedPayload(handler);
        Assert.Equal("gpt-4o-mini", payload.GetProperty("model").GetString());
        Assert.Equal(4000, payload.GetProperty("max_tokens").GetInt32());
        Assert.Equal(0.2m, payload.GetProperty("temperature").GetDecimal());
        Assert.False(payload.TryGetProperty("max_completion_tokens", out _));
    }

    [Fact]
    public async Task CompleteJsonAsync_IncludesResponseBody_WhenOpenAiReturnsBadRequest()
    {
        var handler = new CapturingHttpMessageHandler
        {
            ResponseFactory = _ => new HttpResponseMessage(HttpStatusCode.BadRequest)
            {
                Content = new StringContent(
                    """{"error":{"message":"Unsupported parameter: 'max_tokens' is not supported with this model."}}""",
                    Encoding.UTF8,
                    "application/json"),
            },
        };
        var gateway = CreateGateway(handler, "gpt-5-mini");

        var exception = await Assert.ThrowsAsync<HttpRequestException>(() =>
            gateway.CompleteJsonAsync(
                new LlmPromptRequest("system prompt", "user prompt", null),
                CancellationToken.None));

        Assert.Contains("Unsupported parameter", exception.Message, StringComparison.Ordinal);
    }

    private static OpenAiLlmGateway CreateGateway(
        HttpMessageHandler handler,
        string model,
        int requestTimeoutSeconds = 300)
        => new(
            new StubHttpClientFactory(new HttpClient(handler)
            {
                BaseAddress = new Uri("https://api.openai.com/v1/"),
            }),
            Options.Create(new LlmGatewayOptions
            {
                Provider = LlmProvider.OpenAi,
                ApiKey = "test-key",
                Model = model,
                BaseUrl = "https://api.openai.com/v1/",
                MaxOutputTokens = 4000,
                RequestTimeoutSeconds = requestTimeoutSeconds,
                Temperature = 0.2m,
            }),
            NullLogger<OpenAiLlmGateway>.Instance);

    private static JsonElement ParseCapturedPayload(CapturingHttpMessageHandler handler)
    {
        Assert.NotNull(handler.CapturedRequestContent);
        using var document = JsonDocument.Parse(handler.CapturedRequestContent);
        return document.RootElement.Clone();
    }

    private sealed class StubHttpClientFactory : IHttpClientFactory
    {
        private readonly HttpClient _client;

        public StubHttpClientFactory(HttpClient client)
        {
            _client = client;
        }

        public HttpClient CreateClient(string name) => _client;
    }

    private sealed class CapturingHttpMessageHandler : HttpMessageHandler
    {
        public string? CapturedRequestContent { get; private set; }
        public string? CapturedRequestPath { get; private set; }
        public List<string> RequestPaths { get; } = [];

        public Func<HttpRequestMessage, HttpResponseMessage>? ResponseFactory { get; init; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            CapturedRequestPath = request.RequestUri?.OriginalString;
            if (!string.IsNullOrWhiteSpace(CapturedRequestPath))
            {
                RequestPaths.Add(CapturedRequestPath);
            }

            if (request.Content is not null)
            {
                CapturedRequestContent = await request.Content.ReadAsStringAsync(cancellationToken);
            }

            return ResponseFactory?.Invoke(request) ?? new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    """{"choices":[{"message":{"content":"{\"scenarios\":[]}"}}]}""",
                    Encoding.UTF8,
                    "application/json"),
            };
        }
    }
}
