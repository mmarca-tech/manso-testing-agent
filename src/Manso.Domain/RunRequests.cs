namespace Manso.Domain;

public sealed record RawRunRequest(
    string RequestSource,
    string TriggerType,
    RawIssuePayload Issue,
    RawTriggerInputs TriggerInputs,
    RawIssueFields IssueFields,
    RawRequester RequestedBy);

public sealed record RawIssuePayload(
    string Key,
    string Id,
    string ProjectKey,
    string IssueType,
    string Summary,
    string Description,
    string Url);

public sealed record RawTriggerInputs(
    string? GenerationMode,
    string? WorkflowPass,
    string? TestScope,
    string? RepositoryOverride,
    string? BranchOrPrOverride,
    string? ExtraDocumentationLinks,
    string? CoverageIntent,
    string? OutputTarget);

public sealed record RawIssueFields(
    string? ConfiguredRepository,
    string? DocumentationLinks);

public sealed record RawRequester(
    string? AccountId,
    string? DisplayName,
    string? Email);

public sealed record RequestedBy(
    string? AccountId,
    string? DisplayName,
    string? Email);

public sealed record NormalizedRunRequest(
    string IssueKey,
    string IssueUrl,
    GenerationMode GenerationMode,
    WorkflowPass WorkflowPass,
    TestScope TestScope,
    string? RepositoryAlias,
    string? BranchOrPrHint,
    IReadOnlyList<string> ExplicitDocumentationLinks,
    CoverageIntent CoverageIntent,
    OutputTarget OutputTarget,
    RequestedBy RequestedBy,
    DocumentationMode DocumentationMode);
