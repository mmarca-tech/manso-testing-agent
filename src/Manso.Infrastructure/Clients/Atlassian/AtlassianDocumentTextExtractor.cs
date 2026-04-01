using System.Text;
using System.Text.Json;
using HtmlAgilityPack;

namespace Manso.Infrastructure;

public sealed class AtlassianDocumentTextExtractor
{
    public string ExtractJiraText(JsonElement? document)
    {
        if (document is null || document.Value.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        VisitJiraNode(document.Value, builder);
        return NormalizeWhitespace(builder.ToString());
    }

    public IReadOnlyList<(string Heading, string Text)> ExtractConfluenceChunks(string html, int maxChunks)
    {
        if (string.IsNullOrWhiteSpace(html))
        {
            return Array.Empty<(string Heading, string Text)>();
        }

        var document = new HtmlDocument();
        document.LoadHtml(html);

        var nodes = document.DocumentNode.SelectNodes("//h1|//h2|//h3|//p|//li|//pre|//td|//th");
        if (nodes is null || nodes.Count == 0)
        {
            var fallbackText = NormalizeWhitespace(HtmlEntity.DeEntitize(document.DocumentNode.InnerText));
            return string.IsNullOrWhiteSpace(fallbackText)
                ? Array.Empty<(string Heading, string Text)>()
                : [( "Introduction", fallbackText )];
        }

        var chunks = new List<(string Heading, string Text)>();
        var currentHeading = "Introduction";
        var currentText = new StringBuilder();

        foreach (var node in nodes)
        {
            var nodeName = node.Name.ToLowerInvariant();
            var text = NormalizeWhitespace(HtmlEntity.DeEntitize(node.InnerText));
            if (string.IsNullOrWhiteSpace(text))
            {
                continue;
            }

            if (nodeName is "h1" or "h2" or "h3")
            {
                FlushChunk(chunks, currentHeading, currentText);
                currentHeading = text;
                continue;
            }

            if (currentText.Length > 0)
            {
                currentText.AppendLine();
            }

            currentText.Append(text);
        }

        FlushChunk(chunks, currentHeading, currentText);
        return chunks.Take(maxChunks).ToArray();
    }

    private static void VisitJiraNode(JsonElement node, StringBuilder builder)
    {
        if (node.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        if (node.TryGetProperty("type", out var typeElement))
        {
            var nodeType = typeElement.GetString();
            if (string.Equals(nodeType, "text", StringComparison.OrdinalIgnoreCase) &&
                node.TryGetProperty("text", out var textElement))
            {
                builder.Append(textElement.GetString());
            }
            else if (string.Equals(nodeType, "hardBreak", StringComparison.OrdinalIgnoreCase))
            {
                builder.AppendLine();
            }
        }

        if (node.TryGetProperty("content", out var contentElement) && contentElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var child in contentElement.EnumerateArray())
            {
                VisitJiraNode(child, builder);
            }

            if (node.TryGetProperty("type", out var typeAfterChildren))
            {
                var nodeType = typeAfterChildren.GetString();
                if (nodeType is "paragraph" or "heading" or "listItem" or "blockquote")
                {
                    builder.AppendLine();
                }
            }
        }
    }

    private static void FlushChunk(List<(string Heading, string Text)> chunks, string heading, StringBuilder currentText)
    {
        var text = NormalizeWhitespace(currentText.ToString());
        if (!string.IsNullOrWhiteSpace(text))
        {
            chunks.Add((heading, text));
        }

        currentText.Clear();
    }

    private static string NormalizeWhitespace(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        var lines = value
            .Split('\n', StringSplitOptions.TrimEntries)
            .Select(line => string.Join(' ', line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)))
            .Where(line => !string.IsNullOrWhiteSpace(line))
            .ToArray();

        return string.Join(Environment.NewLine, lines);
    }
}
