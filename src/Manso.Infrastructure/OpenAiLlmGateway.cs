using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Manso.Application;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Manso.Infrastructure;

public sealed class OpenAiLlmGateway : ILlmGateway
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IOptions<LlmGatewayOptions> _options;
    private readonly ILogger<OpenAiLlmGateway> _logger;

    public OpenAiLlmGateway(
        IHttpClientFactory httpClientFactory,
        IOptions<LlmGatewayOptions> options,
        ILogger<OpenAiLlmGateway> logger)
    {
        _httpClientFactory = httpClientFactory;
        _options = options;
        _logger = logger;
    }

    public async Task<LlmCompletionResult> CompleteJsonAsync(
        LlmPromptRequest request,
        CancellationToken ct)
    {
        var options = _options.Value;
        ValidateOptions(options, LlmProvider.OpenAi);

        var payload = new
        {
            model = options.Model,
            temperature = options.Temperature,
            max_tokens = options.MaxOutputTokens,
            response_format = new { type = "json_object" },
            messages = new object[]
            {
                new { role = "system", content = request.SystemPrompt },
                new { role = "user", content = request.UserPrompt },
            },
        };

        using var httpRequest = new HttpRequestMessage(HttpMethod.Post, "chat/completions");
        httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.ApiKey);
        httpRequest.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        _logger.LogInformation("Calling OpenAI model {Model} for scenario generation.", options.Model);

        var client = _httpClientFactory.CreateClient("LlmApi");
        using var response = await client.SendAsync(httpRequest, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        var content = document.RootElement
            .GetProperty("choices")[0]
            .GetProperty("message")
            .GetProperty("content")
            .GetString();

        return new LlmCompletionResult("OpenAi", options.Model, content ?? string.Empty);
    }

    private static void ValidateOptions(LlmGatewayOptions options, LlmProvider expectedProvider)
    {
        if (options.Provider != expectedProvider)
        {
            throw new InvalidOperationException(
                $"OpenAI gateway was invoked with provider '{options.Provider}'.");
        }

        if (string.IsNullOrWhiteSpace(options.ApiKey) || string.IsNullOrWhiteSpace(options.Model))
        {
            throw new InvalidOperationException("Llm:ApiKey and Llm:Model are required for the OpenAI provider.");
        }
    }
}
