namespace Manso.Infrastructure;

public sealed class ScmOptions
{
    public const string SectionName = "Scm";

    public string Provider { get; init; } = string.Empty;

    public string BaseUrl { get; init; } = string.Empty;

    public string Organization { get; init; } = string.Empty;

    public string ReadToken { get; init; } = string.Empty;

    public string WriteToken { get; init; } = string.Empty;
}
