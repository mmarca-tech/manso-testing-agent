namespace Manso.Domain;

public sealed record ValidationMessage(
    string Code,
    string Severity,
    string Message,
    string? FilePath);
