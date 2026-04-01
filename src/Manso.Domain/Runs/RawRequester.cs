namespace Manso.Domain;

public sealed record RawRequester(
    string? AccountId,
    string? DisplayName,
    string? Email);
