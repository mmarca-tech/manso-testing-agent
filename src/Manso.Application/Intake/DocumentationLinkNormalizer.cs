using Manso.Domain;

namespace Manso.Application;

public sealed class DocumentationLinkNormalizer
{
    private readonly ConfluenceLinkOptions _options;

    public DocumentationLinkNormalizer(ConfluenceLinkOptions options)
    {
        _options = options;
    }

    public bool TryNormalize(string candidate, out string? normalizedUrl, out RunWarning? warning)
    {
        normalizedUrl = null;
        warning = null;

        if (!Uri.TryCreate(candidate.Trim().TrimEnd('.', ',', ';'), UriKind.Absolute, out var uri))
        {
            warning = CreateIgnoredWarning(
                $"Ignored documentation value because it is not a valid absolute URL: '{candidate}'.");
            return false;
        }

        if (!uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            warning = CreateIgnoredWarning(
                $"Ignored documentation URL because only HTTPS links are allowed: '{candidate}'.");
            return false;
        }

        if (_options.AllowedHosts.Length > 0 &&
            !_options.AllowedHosts.Contains(uri.Host, StringComparer.OrdinalIgnoreCase))
        {
            warning = CreateIgnoredWarning(
                $"Ignored documentation URL because host '{uri.Host}' is not allowed.");
            return false;
        }

        if (!uri.AbsolutePath.Contains("/wiki/", StringComparison.OrdinalIgnoreCase))
        {
            warning = CreateIgnoredWarning(
                $"Ignored documentation URL because it is not a Confluence wiki URL: '{candidate}'.");
            return false;
        }

        normalizedUrl = uri.ToString();
        return true;
    }

    private static RunWarning CreateIgnoredWarning(string message)
        => new("documentation_link_ignored", message);
}
