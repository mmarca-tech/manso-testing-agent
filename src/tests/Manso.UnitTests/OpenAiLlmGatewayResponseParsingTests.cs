using Manso.Application;
using Manso.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using System.Net;
using System.Text;

namespace Manso.UnitTests;

public sealed class OpenAiLlmGatewayResponseParsingTests
{
    [Fact]
    public async Task CompleteJsonAsync_ReturnsStringMessageContent_WhenPresent()
    {
        var gateway = CreateGateway(
            """
            {
              "choices":[{"message":{"content":"{\"scenarios\":[]}"},"finish_reason":"stop"}],
              "usage": {
                "prompt_tokens": 101,
                "completion_tokens": 23,
                "total_tokens": 124,
                "completion_tokens_details": {
                  "reasoning_tokens": 7
                }
              }
            }
            """);

        var result = await gateway.CompleteJsonAsync(
            new LlmPromptRequest("system prompt", "user prompt", null),
            CancellationToken.None);

        Assert.Equal("{\"scenarios\":[]}", result.JsonOutput);
        Assert.Equal(1, result.ProviderRequestCount);
        Assert.NotNull(result.Usage);
        Assert.Equal(101, result.Usage.InputTokens);
        Assert.Equal(23, result.Usage.OutputTokens);
        Assert.Equal(124, result.Usage.TotalTokens);
        Assert.Equal(7, result.Usage.ReasoningTokens);
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
            {
              "output_text":"{\"scenarios\":[]}",
              "usage": {
                "input_tokens": 50,
                "output_tokens": 12,
                "total_tokens": 62,
                "output_tokens_details": {
                  "reasoning_tokens": 3
                }
              }
            }
            """,
            "gpt-5.4-pro");

        var result = await gateway.CompleteJsonAsync(
            new LlmPromptRequest("system prompt", "user prompt", null),
            CancellationToken.None);

        Assert.Equal("{\"scenarios\":[]}", result.JsonOutput);
        Assert.NotNull(result.Usage);
        Assert.Equal(50, result.Usage.InputTokens);
        Assert.Equal(12, result.Usage.OutputTokens);
        Assert.Equal(62, result.Usage.TotalTokens);
        Assert.Equal(3, result.Usage.ReasoningTokens);
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
