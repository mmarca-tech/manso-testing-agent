namespace Manso.Domain;

public sealed record RequestedBy(
    string? AccountId,
    string? DisplayName,
    string? Email);
