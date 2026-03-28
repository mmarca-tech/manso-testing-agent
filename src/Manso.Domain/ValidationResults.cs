namespace Manso.Domain;

public sealed record ValidationResult(
    ValidationOutcome Outcome,
    IReadOnlyList<ValidationMessage> Messages);

public enum ValidationOutcome
{
    Pass,
    PassWithWarnings,
    Fail,
}

public sealed record ValidationMessage(
    string Code,
    string Severity,
    string Message,
    string? FilePath);
