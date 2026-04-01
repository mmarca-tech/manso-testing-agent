namespace Manso.Domain;

public sealed record NormalizedRunRequest(
    string IssueKey,
    GenerationMode GenerationMode,
    WorkflowPass WorkflowPass,
    TestScope TestScope,
    string? RepositoryAlias,
    IReadOnlyList<string> ExplicitDocumentationLinks,
    CoverageIntent CoverageIntent,
    OutputTarget OutputTarget,
    RequestedBy RequestedBy,
    DocumentationMode DocumentationMode,
    bool DryRun = false);
