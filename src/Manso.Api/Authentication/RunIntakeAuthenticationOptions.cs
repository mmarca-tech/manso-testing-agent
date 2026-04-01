namespace Manso.Api;

public sealed class RunIntakeAuthenticationOptions
{
    public const string SectionName = "RunIntakeAuthentication";

    public string BearerToken { get; init; } = string.Empty;
}
