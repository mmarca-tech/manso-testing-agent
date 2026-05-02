using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace Manso.Infrastructure;

public sealed class OpenAiLlmGateway : ILlmGateway
{
    private static readonly TimeSpan BackgroundPollInterval = TimeSpan.FromSeconds(2);
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
        var usesReasoningModelSettings = UsesReasoningModelSettings(options.Model);
        var usesResponsesApi = UsesResponsesApi(options.Model);
        var usesBackgroundMode = UsesBackgroundMode(options.Model);

        var payload = usesResponsesApi
            ? BuildResponsesPayload(options, request, usesBackgroundMode)
            : BuildChatCompletionsPayload(options, request, usesReasoningModelSettings);

        using var httpRequest = new HttpRequestMessage(
            HttpMethod.Post,
            usesResponsesApi ? "responses" : "chat/completions");
        httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.ApiKey);
        httpRequest.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        _logger.LogInformation("Calling OpenAI model {Model} for scenario generation.", options.Model);

        var client = _httpClientFactory.CreateClient("LlmApi");
        using var response = await client.SendAsync(httpRequest, HttpCompletionOption.ResponseHeadersRead, ct);
        var responseBody = await EnsureSuccessAndReadBodyAsync(client, response, ct);
        using var document = JsonDocument.Parse(responseBody);

        var providerRequestCount = 1;
        JsonElement finalRoot;
        if (usesResponsesApi && usesBackgroundMode)
        {
            var backgroundResult = await PollBackgroundResponseAsync(client, document.RootElement, ct);
            finalRoot = backgroundResult.Root;
            providerRequestCount += backgroundResult.ProviderRequestCount;
        }
        else
        {
            finalRoot = document.RootElement.Clone();
        }

        var content = ExtractContent(finalRoot, finalRoot.GetRawText(), usesResponsesApi);

        return new LlmCompletionResult("OpenAi", options.Model, content)
        {
            Usage = ExtractUsage(finalRoot),
            ProviderRequestCount = providerRequestCount,
        };
    }

    private async Task<BackgroundResponseResult> PollBackgroundResponseAsync(
        HttpClient client,
        JsonElement initialRoot,
        CancellationToken ct)
    {
        var currentRoot = initialRoot.Clone();
        var providerRequestCount = 0;
        var timeout = TimeSpan.FromSeconds(Math.Max(1, _options.Value.RequestTimeoutSeconds));
        var stopwatch = Stopwatch.StartNew();
        while (IsBackgroundResponsePending(currentRoot))
        {
            if (stopwatch.Elapsed >= timeout)
            {
                throw new TimeoutException(
                    $"OpenAI background response exceeded the configured timeout of {_options.Value.RequestTimeoutSeconds} second(s).");
            }

            var responseId = GetRequiredResponseId(currentRoot);
            await Task.Delay(BackgroundPollInterval, ct);

            using var pollRequest = new HttpRequestMessage(HttpMethod.Get, $"responses/{Uri.EscapeDataString(responseId)}");
            pollRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _options.Value.ApiKey);

            using var pollResponse = await client.SendAsync(pollRequest, HttpCompletionOption.ResponseHeadersRead, ct);
            providerRequestCount++;
            var pollBody = await EnsureSuccessAndReadBodyAsync(client, pollResponse, ct);
            using var pollDocument = JsonDocument.Parse(pollBody);
            currentRoot = pollDocument.RootElement.Clone();
        }

        if (!IsCompletedBackgroundResponse(currentRoot))
        {
            throw new InvalidOperationException(
                $"OpenAI background response finished with status '{GetResponseStatus(currentRoot) ?? "unknown"}'. response={SummarizeErrorBody(currentRoot.GetRawText())}");
        }

        return new BackgroundResponseResult(currentRoot, providerRequestCount);
    }

    private static Dictionary<string, object?> BuildChatCompletionsPayload(
        LlmGatewayOptions options,
        LlmPromptRequest request,
        bool usesReasoningModelSettings)
    {
        var payload = new Dictionary<string, object?>
        {
            ["model"] = options.Model,
            ["response_format"] = new { type = "json_object" },
            ["messages"] = new object[]
            {
                new { role = "system", content = request.SystemPrompt },
                new { role = "user", content = request.UserPrompt },
            },
        };
        payload[usesReasoningModelSettings ? "max_completion_tokens" : "max_tokens"] = options.MaxOutputTokens;

        if (!usesReasoningModelSettings)
        {
            payload["temperature"] = options.Temperature;
        }

        return payload;
    }

    private static Dictionary<string, object?> BuildResponsesPayload(
        LlmGatewayOptions options,
        LlmPromptRequest request,
        bool usesBackgroundMode)
        => new()
        {
            ["model"] = options.Model,
            ["instructions"] = request.SystemPrompt,
            ["input"] = request.UserPrompt,
            ["max_output_tokens"] = options.MaxOutputTokens,
            ["background"] = usesBackgroundMode,
            ["text"] = new
            {
                format = new
                {
                    type = "json_object",
                },
            },
        };

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

    internal static bool UsesReasoningModelSettings(string model)
        => !string.IsNullOrWhiteSpace(model) &&
           (model.StartsWith("gpt-5", StringComparison.OrdinalIgnoreCase) ||
            model.StartsWith("o1", StringComparison.OrdinalIgnoreCase) ||
            model.StartsWith("o3", StringComparison.OrdinalIgnoreCase) ||
            model.StartsWith("o4", StringComparison.OrdinalIgnoreCase));

    internal static bool UsesResponsesApi(string model)
        => !string.IsNullOrWhiteSpace(model) &&
           (model.Contains("-pro", StringComparison.OrdinalIgnoreCase) ||
            model.Contains("codex-max", StringComparison.OrdinalIgnoreCase));

    internal static bool UsesBackgroundMode(string model)
        => !string.IsNullOrWhiteSpace(model) &&
           model.Contains("-pro", StringComparison.OrdinalIgnoreCase);

    internal static string SummarizeErrorBody(string? body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return "No response body was returned.";
        }

        var normalized = body.Replace("\r", string.Empty, StringComparison.Ordinal)
            .Replace("\n", " ", StringComparison.Ordinal)
            .Trim();

        return normalized.Length <= 600
            ? normalized
            : normalized[..600];
    }

    internal static string ExtractContent(JsonElement root, string responseBody, bool usesResponsesApi)
        => usesResponsesApi
            ? ExtractResponsesContent(root, responseBody)
            : ExtractChatCompletionsContent(root, responseBody);

    private async Task<string> EnsureSuccessAndReadBodyAsync(
        HttpClient client,
        HttpResponseMessage response,
        CancellationToken ct)
    {
        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(ct);
            var summarizedBody = SummarizeErrorBody(errorBody);

            _logger.LogError(
                "OpenAI request failed with status {StatusCode}. Response: {ResponseBody}",
                (int)response.StatusCode,
                summarizedBody);

            throw new HttpRequestException(
                $"OpenAI request failed with status {(int)response.StatusCode}: {summarizedBody}",
                null,
                response.StatusCode);
        }

        return await response.Content.ReadAsStringAsync(ct);
    }

    private static string ExtractChatCompletionsContent(JsonElement root, string responseBody)
    {
        var choice = root.GetProperty("choices")[0];
        var message = choice.GetProperty("message");
        var content = TryReadMessageContent(message);

        if (!string.IsNullOrWhiteSpace(content))
        {
            return content;
        }

        var finishReason = choice.TryGetProperty("finish_reason", out var finishReasonElement) &&
                           finishReasonElement.ValueKind == JsonValueKind.String
            ? finishReasonElement.GetString()
            : null;
        var refusal = message.TryGetProperty("refusal", out var refusalElement) &&
                      refusalElement.ValueKind == JsonValueKind.String
            ? refusalElement.GetString()
            : null;
        var reasoningTokens = TryReadReasoningTokens(root);

        throw new InvalidOperationException(
            $"OpenAI returned no assistant content. finish_reason={finishReason ?? "unknown"}; " +
            $"refusal={refusal ?? "none"}; reasoning_tokens={(reasoningTokens?.ToString() ?? "unknown")}; " +
            $"response={SummarizeErrorBody(responseBody)}");
    }

    private static string ExtractResponsesContent(JsonElement root, string responseBody)
    {
        if (root.TryGetProperty("output_text", out var outputTextElement) &&
            outputTextElement.ValueKind == JsonValueKind.String &&
            !string.IsNullOrWhiteSpace(outputTextElement.GetString()))
        {
            return outputTextElement.GetString()!;
        }

        if (root.TryGetProperty("output", out var outputElement) &&
            outputElement.ValueKind == JsonValueKind.Array)
        {
            var builder = new StringBuilder();
            foreach (var outputItem in outputElement.EnumerateArray())
            {
                if (!outputItem.TryGetProperty("content", out var contentElement) ||
                    contentElement.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                foreach (var contentItem in contentElement.EnumerateArray())
                {
                    if (contentItem.TryGetProperty("text", out var textElement) &&
                        textElement.ValueKind == JsonValueKind.String)
                    {
                        builder.Append(textElement.GetString());
                    }
                }
            }

            if (builder.Length > 0)
            {
                return builder.ToString();
            }
        }

        throw new InvalidOperationException(
            $"OpenAI Responses API returned no output_text content. response={SummarizeErrorBody(responseBody)}");
    }

    private static string? TryReadMessageContent(JsonElement message)
    {
        if (!message.TryGetProperty("content", out var contentElement))
        {
            return null;
        }

        if (contentElement.ValueKind == JsonValueKind.String)
        {
            return contentElement.GetString();
        }

        if (contentElement.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var builder = new StringBuilder();
        foreach (var item in contentElement.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String)
            {
                builder.Append(item.GetString());
                continue;
            }

            if (item.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            if (item.TryGetProperty("text", out var textElement) &&
                textElement.ValueKind == JsonValueKind.String)
            {
                builder.Append(textElement.GetString());
            }
        }

        return builder.Length == 0
            ? null
            : builder.ToString();
    }

    internal static LlmUsageMetrics? ExtractUsage(JsonElement root)
    {
        if (!root.TryGetProperty("usage", out var usageElement) ||
            usageElement.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var inputTokens = TryReadInt(usageElement, "input_tokens")
                          ?? TryReadInt(usageElement, "prompt_tokens");
        var outputTokens = TryReadInt(usageElement, "output_tokens")
                           ?? TryReadInt(usageElement, "completion_tokens");
        var totalTokens = TryReadInt(usageElement, "total_tokens");
        var reasoningTokens = TryReadNestedInt(usageElement, "output_tokens_details", "reasoning_tokens")
                              ?? TryReadNestedInt(usageElement, "completion_tokens_details", "reasoning_tokens");

        return inputTokens is null &&
               outputTokens is null &&
               totalTokens is null &&
               reasoningTokens is null
            ? null
            : new LlmUsageMetrics(inputTokens, outputTokens, totalTokens, reasoningTokens);
    }

    private static int? TryReadReasoningTokens(JsonElement root)
        => ExtractUsage(root)?.ReasoningTokens;

    private static int? TryReadInt(JsonElement element, string propertyName)
        => element.TryGetProperty(propertyName, out var valueElement) &&
           valueElement.ValueKind == JsonValueKind.Number &&
           valueElement.TryGetInt32(out var value)
            ? value
            : null;

    private static int? TryReadNestedInt(JsonElement element, string propertyName, string childPropertyName)
        => element.TryGetProperty(propertyName, out var childElement) &&
           childElement.ValueKind == JsonValueKind.Object
            ? TryReadInt(childElement, childPropertyName)
            : null;

    private static bool IsBackgroundResponsePending(JsonElement root)
        => GetResponseStatus(root) is "queued" or "in_progress";

    private static bool IsCompletedBackgroundResponse(JsonElement root)
        => string.Equals(GetResponseStatus(root), "completed", StringComparison.OrdinalIgnoreCase) ||
           HasResponsesOutput(root);

    private static string? GetResponseStatus(JsonElement root)
        => root.TryGetProperty("status", out var statusElement) &&
           statusElement.ValueKind == JsonValueKind.String
            ? statusElement.GetString()
            : null;

    private static string GetRequiredResponseId(JsonElement root)
    {
        if (root.TryGetProperty("id", out var idElement) &&
            idElement.ValueKind == JsonValueKind.String &&
            !string.IsNullOrWhiteSpace(idElement.GetString()))
        {
            return idElement.GetString()!;
        }

        throw new InvalidOperationException(
            $"OpenAI background response did not return an id. response={SummarizeErrorBody(root.GetRawText())}");
    }

    private static bool HasResponsesOutput(JsonElement root)
        => (root.TryGetProperty("output_text", out var outputTextElement) &&
            outputTextElement.ValueKind == JsonValueKind.String &&
            !string.IsNullOrWhiteSpace(outputTextElement.GetString())) ||
           (root.TryGetProperty("output", out var outputElement) &&
            outputElement.ValueKind == JsonValueKind.Array &&
            outputElement.GetArrayLength() > 0);

    private sealed record BackgroundResponseResult(
        JsonElement Root,
        int ProviderRequestCount);
}
