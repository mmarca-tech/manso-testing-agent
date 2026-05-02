using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace Manso.Infrastructure;

public sealed class AnthropicLlmGateway : ILlmGateway
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IOptions<LlmGatewayOptions> _options;
    private readonly ILogger<AnthropicLlmGateway> _logger;

    public AnthropicLlmGateway(
        IHttpClientFactory httpClientFactory,
        IOptions<LlmGatewayOptions> options,
        ILogger<AnthropicLlmGateway> logger)
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
        ValidateOptions(options, LlmProvider.Anthropic);

        var payload = new
        {
            model = options.Model,
            max_tokens = options.MaxOutputTokens,
            temperature = options.Temperature,
            system = request.SystemPrompt,
            messages = new object[]
            {
                new
                {
                    role = "user",
                    content = new object[]
                    {
                        new
                        {
                            type = "text",
                            text = request.UserPrompt,
                        },
                    },
                },
            },
        };

        using var httpRequest = new HttpRequestMessage(HttpMethod.Post, "messages");
        httpRequest.Headers.Add("x-api-key", options.ApiKey);
        httpRequest.Headers.Add("anthropic-version", "2023-06-01");
        httpRequest.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        httpRequest.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        _logger.LogInformation("Calling Anthropic model {Model} for scenario generation.", options.Model);

        var client = _httpClientFactory.CreateClient("LlmApi");
        using var response = await client.SendAsync(httpRequest, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        var contentItems = document.RootElement.GetProperty("content").EnumerateArray();
        var text = string.Join(
            Environment.NewLine,
            contentItems
                .Where(item => item.TryGetProperty("type", out var typeElement) &&
                               typeElement.GetString() == "text")
                .Select(item => item.TryGetProperty("text", out var textElement) ? textElement.GetString() : null)
                .Where(value => !string.IsNullOrWhiteSpace(value)));

        return new LlmCompletionResult("Anthropic", options.Model, text)
        {
            Usage = ExtractUsage(document.RootElement),
            ProviderRequestCount = 1,
        };
    }

    private static void ValidateOptions(LlmGatewayOptions options, LlmProvider expectedProvider)
    {
        if (options.Provider != expectedProvider)
        {
            throw new InvalidOperationException(
                $"Anthropic gateway was invoked with provider '{options.Provider}'.");
        }

        if (string.IsNullOrWhiteSpace(options.ApiKey) || string.IsNullOrWhiteSpace(options.Model))
        {
            throw new InvalidOperationException("Llm:ApiKey and Llm:Model are required for the Anthropic provider.");
        }
    }

    private static LlmUsageMetrics? ExtractUsage(JsonElement root)
    {
        if (!root.TryGetProperty("usage", out var usageElement) ||
            usageElement.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var inputTokens = TryReadInt(usageElement, "input_tokens");
        var outputTokens = TryReadInt(usageElement, "output_tokens");
        var totalTokens = inputTokens is not null && outputTokens is not null
            ? inputTokens + outputTokens
            : null;

        return inputTokens is null && outputTokens is null
            ? null
            : new LlmUsageMetrics(inputTokens, outputTokens, totalTokens, null);
    }

    private static int? TryReadInt(JsonElement element, string propertyName)
        => element.TryGetProperty(propertyName, out var valueElement) &&
           valueElement.ValueKind == JsonValueKind.Number &&
           valueElement.TryGetInt32(out var value)
            ? value
            : null;
}
