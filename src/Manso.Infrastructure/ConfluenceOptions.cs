namespace Manso.Infrastructure;

public sealed class ConfluenceOptions
{
    public const string SectionName = "Confluence";

    public string BaseUrl { get; init; } = string.Empty;

    public string UserEmail { get; init; } = string.Empty;

    public string ApiToken { get; init; } = string.Empty;

    public string[] AllowedHosts { get; init; } = Array.Empty<string>();
}
