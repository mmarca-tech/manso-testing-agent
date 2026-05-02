namespace Manso.Domain;

public sealed record GenerationContextBundle(
    string IssueKey,
    TestScope TestScope,
    WorkflowPass WorkflowPass,
    IReadOnlyList<GenerationContextSection> Sections,
    IReadOnlyList<RunWarning> Warnings,
    int DocumentationDocumentCount,
    int ChangedFileCount,
    int NeighboringTestCount,
    int XrayNeighboringTestCount);
