using System.Net;
using System.Text;
using Manso.Application;
using Manso.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Manso.UnitTests;

public sealed class OpenAiLlmGatewayResponseParsingTests
{
    [Fact]
    public async Task CompleteJsonAsync_ReturnsStringMessageContent_WhenPresent()
    {
        var gateway = CreateGateway(
            """
            {"choices":[{"message":{"content":"{\"scenarios\":[]}"},"finish_reason":"stop"}]}
            """);

        var result = await gateway.CompleteJsonAsync(
            new LlmPromptRequest("system prompt", "user prompt", null),
            CancellationToken.None);

        Assert.Equal("{\"scenarios\":[]}", result.JsonOutput);
    }

    [Fact]
    public async Task CompleteJsonAsync_ConcatenatesArrayContentTextParts_WhenPresent()
    {
        var gateway = CreateGateway(
            """
            {
              "choices": [
                {
                  "message": {
                    "content": [
                      { "type": "output_text", "text": "{\"scenarios\":" },
                      { "type": "output_text", "text": "[]}" }
                    ]
                  },
                  "finish_reason": "stop"
                }
              ]
            }
            """);

        var result = await gateway.CompleteJsonAsync(
            new LlmPromptRequest("system prompt", "user prompt", null),
            CancellationToken.None);

        Assert.Equal("{\"scenarios\":[]}", result.JsonOutput);
    }

    [Fact]
    public async Task CompleteJsonAsync_ThrowsHelpfulError_WhenAssistantContentIsMissing()
    {
        var gateway = CreateGateway(
            """
            {
              "choices": [
                {
                  "message": {
                    "content": null,
                    "refusal": null
                  },
                  "finish_reason": "length"
                }
              ],
              "usage": {
                "completion_tokens_details": {
                  "reasoning_tokens": 4000
                }
              }
            }
            """);

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            gateway.CompleteJsonAsync(
                new LlmPromptRequest("system prompt", "user prompt", null),
                CancellationToken.None));

        Assert.Contains("finish_reason=length", exception.Message, StringComparison.Ordinal);
        Assert.Contains("reasoning_tokens=4000", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CompleteJsonAsync_ReturnsResponsesApiOutputText_WhenPresent()
    {
        var gateway = CreateGateway(
            """
            {"output_text":"{\"scenarios\":[]}"}
            """,
            "gpt-5.4-pro");

        var result = await gateway.CompleteJsonAsync(
            new LlmPromptRequest("system prompt", "user prompt", null),
            CancellationToken.None);

        Assert.Equal("{\"scenarios\":[]}", result.JsonOutput);
    }

    private static OpenAiLlmGateway CreateGateway(string responseJson, string model = "gpt-5-mini")
        => new(
            new StubHttpClientFactory(new HttpClient(new FixedResponseHandler(responseJson))
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
            }),
            NullLogger<OpenAiLlmGateway>.Instance);

    private sealed class StubHttpClientFactory : IHttpClientFactory
    {
        private readonly HttpClient _client;

        public StubHttpClientFactory(HttpClient client)
        {
            _client = client;
        }

        public HttpClient CreateClient(string name) => _client;
    }

    private sealed class FixedResponseHandler : HttpMessageHandler
    {
        private readonly string _responseJson;

        public FixedResponseHandler(string responseJson)
        {
            _responseJson = responseJson;
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(_responseJson, Encoding.UTF8, "application/json"),
            });
    }
}
