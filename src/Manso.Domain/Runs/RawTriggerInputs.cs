namespace Manso.Domain;

public sealed record RawTriggerInputs(
    string? GenerationMode,
    string? WorkflowPass,
    string? ExtraDocumentationLinks,
    string? CoverageIntent,
    string? OutputTarget,
    bool DryRun = false);
