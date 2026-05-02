using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace Manso.Infrastructure;

public sealed class ConfluenceApiClient : IConfluenceApiClient
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly AtlassianDocumentTextExtractor _textExtractor;
    private readonly IOptions<ConfluenceOptions> _options;
    private readonly ILogger<ConfluenceApiClient> _logger;

    public ConfluenceApiClient(
        IHttpClientFactory httpClientFactory,
        AtlassianDocumentTextExtractor textExtractor,
        IOptions<ConfluenceOptions> options,
        ILogger<ConfluenceApiClient> logger)
    {
        _httpClientFactory = httpClientFactory;
        _textExtractor = textExtractor;
        _options = options;
        _logger = logger;
    }

    public async Task<ConfluenceDocument> GetDocumentAsync(
        string sourceUrl,
        string pageId,
        int maxChunks,
        CancellationToken ct)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            $"rest/api/content/{Uri.EscapeDataString(pageId)}?expand=body.storage,version,space");
        request.Headers.Authorization = BasicAuthenticationHeaderFactory.Create(_options.Value.UserEmail, _options.Value.ApiToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        _logger.LogInformation("Calling Confluence API GET {Path} for page {PageId}.", request.RequestUri, pageId);

        var client = _httpClientFactory.CreateClient("ConfluenceApi");
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            throw new InvalidOperationException($"Confluence page '{pageId}' was not found.");
        }

        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            throw new InvalidOperationException($"Confluence request for page '{pageId}' was rejected with status {(int)response.StatusCode}.");
        }

        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: ct);

        var root = document.RootElement;
        var html = root.GetProperty("body").GetProperty("storage").GetProperty("value").GetString() ?? string.Empty;
        var chunks = _textExtractor.ExtractConfluenceChunks(html, maxChunks)
            .Select((chunk, index) => new ConfluenceChunk(
                $"{pageId}-{index + 1}",
                chunk.Heading,
                chunk.Text,
                EstimateTokens(chunk.Text)))
            .ToArray();

        return new ConfluenceDocument(
            sourceUrl,
            root.GetProperty("id").GetString() ?? pageId,
            root.GetProperty("title").GetString() ?? string.Empty,
            root.GetProperty("space").GetProperty("key").GetString() ?? string.Empty,
            root.GetProperty("version").GetProperty("number").GetInt32(),
            TryGetDateTimeOffset(root.GetProperty("version"), "when"),
            chunks);
    }

    private static int EstimateTokens(string value)
        => Math.Max(1, (int)Math.Ceiling(value.Length / 4d));

    private static DateTimeOffset? TryGetDateTimeOffset(JsonElement parent, string propertyName)
        => parent.TryGetProperty(propertyName, out var value) &&
           DateTimeOffset.TryParse(value.GetString(), out var parsed)
            ? parsed
            : null;

}
