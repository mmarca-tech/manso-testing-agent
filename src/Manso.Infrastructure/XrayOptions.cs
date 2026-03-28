namespace Manso.Infrastructure;

public sealed class XrayOptions
{
    public const string SectionName = "Xray";

    public string BaseUrl { get; init; } = "https://xray.cloud.getxray.app/api/v2/";

    public string ClientId { get; init; } = string.Empty;

    public string ClientSecret { get; init; } = string.Empty;
}
