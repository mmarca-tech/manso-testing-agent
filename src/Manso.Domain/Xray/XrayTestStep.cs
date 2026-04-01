namespace Manso.Domain;

public sealed record XrayTestStep(
    string Action,
    string? Data,
    string? Result);
