using System.Text.RegularExpressions;

namespace Manso.Infrastructure;

internal static partial class SensitiveContentRedactor
{
    private static readonly string[] SensitiveKeyFragments =
    [
        "secret",
        "password",
        "token",
        "certificate",
        "cert",
        "privatekey",
        "private_key",
        "api_key",
        "apikey",
        "client_secret",
        "connectionstring",
        "connection_string",
        "sas",
        "accesskey",
        "access_key",
    ];

    public static string? Redact(string path, string? content)
    {
        if (string.IsNullOrWhiteSpace(content) || !ShouldInspect(path))
        {
            return content;
        }

        var lines = content.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
        string? currentYamlKey = null;

        for (var index = 0; index < lines.Length; index++)
        {
            var line = lines[index];
            var trimmed = line.Trim();
            if (trimmed.Length == 0)
            {
                continue;
            }

            if (TryGetYamlKeyWithoutInlineValue(trimmed, out var yamlKey))
            {
                currentYamlKey = yamlKey;
                continue;
            }

            if (TryRedactYamlInlineKeyValue(line, out var redactedInlineLine))
            {
                lines[index] = redactedInlineLine;
                continue;
            }

            if (TryRedactYamlValueLine(line, currentYamlKey, out var redactedValueLine))
            {
                lines[index] = redactedValueLine;
                continue;
            }

            if (TryRedactJsonLine(line, out var redactedJsonLine))
            {
                lines[index] = redactedJsonLine;
            }
        }

        return string.Join(Environment.NewLine, lines);
    }

    private static bool ShouldInspect(string path)
    {
        var normalizedPath = path.Replace('\\', '/');
        return normalizedPath.Contains("/settings/", StringComparison.OrdinalIgnoreCase) ||
               normalizedPath.EndsWith(".yaml", StringComparison.OrdinalIgnoreCase) ||
               normalizedPath.EndsWith(".yml", StringComparison.OrdinalIgnoreCase) ||
               normalizedPath.EndsWith(".json", StringComparison.OrdinalIgnoreCase) ||
               normalizedPath.EndsWith(".config", StringComparison.OrdinalIgnoreCase) ||
               normalizedPath.EndsWith(".env", StringComparison.OrdinalIgnoreCase);
    }

    private static bool TryGetYamlKeyWithoutInlineValue(string trimmedLine, out string key)
    {
        key = string.Empty;
        var separatorIndex = trimmedLine.IndexOf(':');
        if (separatorIndex <= 0 || separatorIndex != trimmedLine.Length - 1)
        {
            return false;
        }

        key = trimmedLine[..separatorIndex].Trim();
        return key.Length > 0;
    }

    private static bool TryRedactYamlInlineKeyValue(string line, out string redacted)
    {
        redacted = string.Empty;
        var match = YamlInlineKeyValueRegex().Match(line);
        if (!match.Success)
        {
            return false;
        }

        var key = match.Groups["key"].Value;
        var value = match.Groups["value"].Value.Trim();
        if (!LooksSensitive(key, value))
        {
            return false;
        }

        redacted = $"{match.Groups["indent"].Value}{key}: [REDACTED]";
        return true;
    }

    private static bool TryRedactYamlValueLine(string line, string? currentYamlKey, out string redacted)
    {
        redacted = string.Empty;
        var match = YamlValueRegex().Match(line);
        if (!match.Success)
        {
            return false;
        }

        var value = match.Groups["value"].Value.Trim();
        if (!LooksSensitive(currentYamlKey, value))
        {
            return false;
        }

        redacted = $"{match.Groups["indent"].Value}value: [REDACTED]";
        return true;
    }

    private static bool TryRedactJsonLine(string line, out string redacted)
    {
        redacted = string.Empty;
        var match = JsonKeyValueRegex().Match(line);
        if (!match.Success)
        {
            return false;
        }

        var key = match.Groups["key"].Value;
        var value = match.Groups["value"].Value;
        if (!LooksSensitive(key, value))
        {
            return false;
        }

        redacted = $"{match.Groups["prefix"].Value}\"{key}\": \"[REDACTED]\"{match.Groups["suffix"].Value}";
        return true;
    }

    private static bool LooksSensitive(string? key, string value)
    {
        if (!string.IsNullOrWhiteSpace(key) &&
            SensitiveKeyFragments.Any(fragment => key.Contains(fragment, StringComparison.OrdinalIgnoreCase)))
        {
            return true;
        }

        return value.Length >= 40 && SecretLikeValueRegex().IsMatch(value);
    }

    [GeneratedRegex("^(?<indent>\\s*)(?<key>[A-Za-z0-9_.-]+):\\s*(?<value>.+?)\\s*$", RegexOptions.Compiled)]
    private static partial Regex YamlInlineKeyValueRegex();

    [GeneratedRegex("^(?<indent>\\s*)value:\\s*(?<value>.+?)\\s*$", RegexOptions.Compiled | RegexOptions.IgnoreCase)]
    private static partial Regex YamlValueRegex();

    [GeneratedRegex("^(?<prefix>\\s*)\"(?<key>[^\"]+)\":\\s*\"(?<value>[^\"]*)\"(?<suffix>\\s*,?\\s*)$", RegexOptions.Compiled)]
    private static partial Regex JsonKeyValueRegex();

    [GeneratedRegex("^[A-Za-z0-9+/=_-]{40,}$", RegexOptions.Compiled)]
    private static partial Regex SecretLikeValueRegex();
}
