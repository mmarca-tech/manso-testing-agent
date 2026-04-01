namespace Manso.Infrastructure;

public sealed class JiraOptions
{
    public const string SectionName = "Jira";

    public string BaseUrl { get; init; } = string.Empty;

    public string CloudId { get; init; } = string.Empty;

    public string UserEmail { get; init; } = string.Empty;

    public string ApiToken { get; init; } = string.Empty;
}
