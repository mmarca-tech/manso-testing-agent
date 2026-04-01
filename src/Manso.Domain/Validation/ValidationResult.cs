namespace Manso.Domain;

public sealed record ValidationResult(
    ValidationOutcome Outcome,
    IReadOnlyList<ValidationMessage> Messages);
