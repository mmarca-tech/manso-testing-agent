using Manso.Domain;
using Microsoft.Extensions.Logging;
using System.Text;

namespace Manso.Application;

public sealed class GenerationContextBundleBuilder : IGenerationContextBundleBuilder
{
    private readonly GenerationContextOptions _options;
    private readonly IRuntimePromptSectionProvider _runtimePromptSectionProvider;
    private readonly ILogger<GenerationContextBundleBuilder> _logger;

    public GenerationContextBundleBuilder(
        GenerationContextOptions options,
        IRuntimePromptSectionProvider runtimePromptSectionProvider,
        ILogger<GenerationContextBundleBuilder> logger)
    {
        _options = options;
        _runtimePromptSectionProvider = runtimePromptSectionProvider;
        _logger = logger;
    }

    public Task<GenerationContextBundle> BuildAsync(
        NormalizedRunRequest request,
        JiraIssueContext jira,
        IReadOnlyList<ConfluenceDocument> documents,
        RepositoryTarget? repositoryTarget,
        RepositoryContextBundle? repositoryContext,
        XrayContextBundle xrayContext,
        CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var warnings = new List<RunWarning>();
        var sections = new List<GenerationContextSection>
        {
            new("run_metadata", "RUN METADATA", BuildRunMetadataSection(request, repositoryTarget)),
            new("jira_issue", "JIRA ISSUE", BuildJiraIssueSection(jira)),
        };

        AddSectionIfNotEmpty(sections, "description_referenced_jira_issues", "DESCRIPTION-REFERENCED JIRA ISSUES", BuildDescriptionReferencedIssuesSection(jira));
        AddSectionIfNotEmpty(sections, "acceptance_criteria", "ACCEPTANCE CRITERIA", BuildAcceptanceCriteriaSection(jira));
        AddSectionIfNotEmpty(sections, "selected_comments", "SELECTED COMMENTS", BuildCommentsSection(jira.Comments));
        AddSectionIfNotEmpty(sections, "explicit_confluence_docs", "EXPLICIT CONFLUENCE DOCS", BuildDocumentationSection(documents));

        var repoSummary = BuildRepositorySummarySection(repositoryTarget, repositoryContext);
        sections.Add(new GenerationContextSection(
            "repo_change_summary",
            "REPO CHANGE SUMMARY",
            repoSummary));

        AddSectionOrWarning(
            sections,
            warnings,
            "changed_code_excerpts",
            "CHANGED CODE EXCERPTS",
            BuildChangedCodeSection(repositoryContext),
            "generation_context_without_code_diff",
            "Generation context was built without repository diff excerpts.");

        AddSectionOrWarning(
            sections,
            warnings,
            "neighboring_test_patterns",
            "NEIGHBORING TEST PATTERNS",
            BuildNeighboringTestsSection(repositoryContext),
            "generation_context_without_neighboring_tests",
            "Generation context was built without neighboring test patterns.");

        AddSectionIfNotEmpty(sections, "existing_xray_coverage_index", "EXISTING XRAY COVERAGE INDEX", BuildExistingCoverageIndexSection(jira, xrayContext));
        AddSectionIfNotEmpty(sections, "existing_linked_xray_tests", "EXISTING LINKED XRAY TESTS", BuildLinkedXrayTestsSection(jira, xrayContext));
        AddSectionIfNotEmpty(sections, "xray_neighboring_tests", "XRAY NEIGHBORING TESTS", BuildXrayTestsSection(xrayContext));
        AddRepositoryGuidanceSections(sections, repositoryContext);
        AddSectionIfNotEmpty(sections, "repo_test_conventions", "REPO TEST CONVENTIONS", BuildRepositoryConventionsSection(repositoryContext));

        var runtimeGuardrailsSection = _runtimePromptSectionProvider.BuildScenarioGenerationSection(
            request.TestScope,
            request.WorkflowPass);
        if (!string.IsNullOrWhiteSpace(runtimeGuardrailsSection.Content))
        {
            sections.Add(runtimeGuardrailsSection);
        }

        sections.Add(new GenerationContextSection(
            "output_contract",
            "OUTPUT CONTRACT",
            BuildOutputContractSection(request)));

        var bundle = new GenerationContextBundle(
            request.IssueKey,
            request.TestScope,
            request.WorkflowPass,
            sections,
            warnings
                .Concat(repositoryContext?.Warnings ?? Array.Empty<RunWarning>())
                .Concat(xrayContext.Warnings)
                .ToArray(),
            documents.Count,
            repositoryContext?.ChangedFiles.Count ?? 0,
            repositoryContext?.NeighboringTests.Count ?? 0,
            xrayContext.NeighboringTests.Count);

        _logger.LogInformation(
            "Built generation context bundle with {SectionCount} sections, {DocumentCount} docs, {ChangedFileCount} changed files, and {NeighboringTestCount} neighboring tests.",
            bundle.Sections.Count,
            bundle.DocumentationDocumentCount,
            bundle.ChangedFileCount,
            bundle.NeighboringTestCount);

        return Task.FromResult(bundle);
    }

    private static string BuildRunMetadataSection(NormalizedRunRequest request, RepositoryTarget? repositoryTarget)
    {
        var builder = new StringBuilder();
        builder.AppendLine($"Issue Key: {request.IssueKey}");
        builder.AppendLine($"Workflow Pass: {request.WorkflowPass}");
        builder.AppendLine($"Test Scope: {request.TestScope}");
        builder.AppendLine($"Repository Alias: {repositoryTarget?.Alias ?? request.RepositoryAlias ?? "Not available"}");
        builder.Append($"Pull Request Reference: {FormatPullRequestReferences(repositoryTarget)}");
        return builder.ToString().Trim();
    }

    private static string BuildJiraIssueSection(JiraIssueContext jira)
    {
        var builder = new StringBuilder();
        builder.AppendLine($"Summary: {jira.Summary}");
        builder.AppendLine($"Issue Type: {jira.IssueType}");
        builder.AppendLine($"Priority: {jira.Priority ?? "Not set"}");
        if (jira.Labels.Count > 0)
        {
            builder.AppendLine($"Labels: {string.Join(", ", jira.Labels)}");
        }

        builder.AppendLine();
        builder.Append(jira.Description.Trim());
        return builder.ToString().Trim();
    }

    private static string BuildAcceptanceCriteriaSection(JiraIssueContext jira)
        => AcceptanceCriteriaReferenceFormatter.BuildSectionContent(jira.AcceptanceCriteria);

    private static string BuildDescriptionReferencedIssuesSection(JiraIssueContext jira)
    {
        if (jira.DescriptionReferencedIssues.Count == 0)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        builder.AppendLine("These Jira issues were explicitly referenced in the main ticket description. Use them as supporting business and implementation context for the main ticket.");
        builder.AppendLine();

        foreach (var referencedIssue in jira.DescriptionReferencedIssues)
        {
            builder.AppendLine($"Issue: {referencedIssue.IssueKey} - {referencedIssue.Summary}");
            builder.AppendLine(referencedIssue.Description.Trim());
            builder.AppendLine();
        }

        return builder.ToString().Trim();
    }

    private string BuildCommentsSection(IReadOnlyList<JiraCommentContext> comments)
    {
        if (comments.Count == 0)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        foreach (var comment in comments.Take(_options.MaxComments))
        {
            builder.AppendLine($"- {(comment.AuthorDisplayName ?? "Unknown")} ({comment.CreatedAtUtc:O})");
            builder.AppendLine(comment.Body.Trim());
            builder.AppendLine();
        }

        return builder.ToString().Trim();
    }

    private static string BuildDocumentationSection(IReadOnlyList<ConfluenceDocument> documents)
    {
        if (documents.Count == 0)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        foreach (var document in documents)
        {
            builder.AppendLine($"Document: {document.Title} ({document.SpaceKey})");
            foreach (var chunk in document.Chunks)
            {
                builder.AppendLine($"[{chunk.HeadingPath}]");
                builder.AppendLine(chunk.Text);
            }

            builder.AppendLine();
        }

        return builder.ToString().Trim();
    }

    private static string BuildRepositorySummarySection(
        RepositoryTarget? repositoryTarget,
        RepositoryContextBundle? repositoryContext)
    {
        if (repositoryTarget is null)
        {
            return "Repository PR or branch context was not available for this run.";
        }

        var builder = new StringBuilder();
        builder.AppendLine($"Repository: {repositoryTarget.RepositoryName}");
        builder.AppendLine($"Provider: {repositoryTarget.Provider}");
        builder.AppendLine($"Branch: {repositoryTarget.BranchName ?? repositoryTarget.DefaultBranch}");
        builder.AppendLine($"Pull Request: {FormatPullRequestReferences(repositoryTarget)}");
        builder.AppendLine($"Changed Files: {repositoryContext?.ChangedFiles.Count ?? 0}");

        if (repositoryContext is not null)
        {
            foreach (var change in repositoryContext.ChangedFiles)
            {
                builder.AppendLine($"- {change.ChangeKind}: {change.Path}");
            }
        }

        return builder.ToString().Trim();
    }

    private string BuildChangedCodeSection(RepositoryContextBundle? repositoryContext)
    {
        if (repositoryContext is null || repositoryContext.ChangedFiles.Count == 0)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        foreach (var change in repositoryContext.ChangedFiles.Take(_options.MaxChangedFileExcerpts))
        {
            if (string.IsNullOrWhiteSpace(change.DiffPreview))
            {
                continue;
            }

            builder.AppendLine($"File: {change.Path}");
            builder.AppendLine(change.DiffPreview.Trim());
            builder.AppendLine();
        }

        return builder.ToString().Trim();
    }

    private string BuildNeighboringTestsSection(RepositoryContextBundle? repositoryContext)
    {
        if (repositoryContext is null || repositoryContext.NeighboringTests.Count == 0)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        foreach (var testFile in repositoryContext.NeighboringTests.Take(_options.MaxNeighboringTests))
        {
            builder.AppendLine($"Test File: {testFile.Path}");
            builder.AppendLine($"Reason: {testFile.MatchReason}");
            builder.AppendLine(testFile.Content.Trim());
            builder.AppendLine();
        }

        return builder.ToString().Trim();
    }

    private static void AddRepositoryGuidanceSections(
        ICollection<GenerationContextSection> sections,
        RepositoryContextBundle? repositoryContext)
    {
        if (repositoryContext is null || repositoryContext.GuidanceFiles.Count == 0)
        {
            return;
        }

        AddGuidanceSectionIfPresent(
            sections,
            repositoryContext,
            RepositoryGuidancePaths.TestArchitecture,
            "repo_test_architecture",
            "REPO TEST ARCHITECTURE");
        AddGuidanceSectionIfPresent(
            sections,
            repositoryContext,
            RepositoryGuidancePaths.AiTestGeneration,
            "repo_generation_guidance",
            "REPO AI TEST GENERATION GUIDANCE");
        AddGuidanceSectionIfPresent(
            sections,
            repositoryContext,
            RepositoryGuidancePaths.MansoTestGeneration,
            "repo_manso_testgen",
            "REPO MANSO TESTGEN GUIDANCE");
        AddGuidanceSectionIfPresent(
            sections,
            repositoryContext,
            RepositoryGuidancePaths.RepoConventions,
            "repo_conventions_json",
            "REPO CONVENTIONS JSON");
    }

    private static void AddGuidanceSectionIfPresent(
        ICollection<GenerationContextSection> sections,
        RepositoryContextBundle repositoryContext,
        string path,
        string key,
        string title)
    {
        var file = repositoryContext.GuidanceFiles.FirstOrDefault(candidate =>
            NormalizeGuidancePath(candidate.Path).Equals(path, StringComparison.OrdinalIgnoreCase));
        if (file is null || string.IsNullOrWhiteSpace(file.Content))
        {
            return;
        }

        sections.Add(new GenerationContextSection(
            key,
            title,
            $"Source: {file.Path}{Environment.NewLine}{Environment.NewLine}{file.Content.Trim()}"));
    }

    private static string NormalizeGuidancePath(string path)
    {
        var normalized = path.Replace('\\', '/').Trim();
        return normalized.StartsWith("/", StringComparison.Ordinal)
            ? normalized
            : $"/{normalized}";
    }

    private static string BuildRepositoryConventionsSection(RepositoryContextBundle? repositoryContext)
    {
        if (repositoryContext is null)
        {
            return string.Empty;
        }

        var conventions = repositoryContext.Conventions;
        var builder = new StringBuilder();
        builder.AppendLine($"Adapter Alias: {conventions.AdapterAlias}");
        builder.AppendLine($"Supports Executable Generation: {conventions.SupportsExecutableTestGeneration}");
        builder.AppendLine($"Test Framework: {FormatOrDefault(conventions.TestFramework)}");
        builder.AppendLine($"Target Framework: {FormatOrDefault(conventions.TargetFramework)}");
        builder.AppendLine($"Test File Suffix: {FormatOrDefault(conventions.TestFileSuffix)}");
        builder.AppendLine($"Test Directories: {FormatOrDefault(conventions.TestDirectoryRoots)}");
        builder.AppendLine($"Helper Directories: {FormatOrDefault(conventions.AllowedHelperDirectoryRoots)}");
        builder.AppendLine($"Protected Paths: {FormatOrDefault(conventions.ProtectedPathPrefixes)}");
        builder.AppendLine($"Build Commands: {FormatOrDefault(conventions.BuildCommands)}");
        builder.AppendLine($"Test Commands: {FormatOrDefault(conventions.TestCommands)}");
        builder.AppendLine($"Formatter Commands: {FormatOrDefault(conventions.FormatterCommands)}");
        builder.Append($"Linter Commands: {FormatOrDefault(conventions.LinterCommands)}");
        return builder.ToString().Trim();
    }

    private static string BuildLinkedXrayTestsSection(
        JiraIssueContext jira,
        XrayContextBundle xrayContext)
    {
        var linkedTestSummariesByKey = BuildLinkedTestSummaryMap(jira, xrayContext);

        if (linkedTestSummariesByKey.Count == 0)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        builder.AppendLine("Treat these linked test titles as existing ticket coverage and avoid generating duplicate scenarios.");
        foreach (var linkedTest in linkedTestSummariesByKey.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase))
        {
            builder.AppendLine($"- {linkedTest.Key}: {linkedTest.Value ?? "Title unavailable"}");
        }

        return builder.ToString().Trim();
    }

    private static string BuildExistingCoverageIndexSection(
        JiraIssueContext jira,
        XrayContextBundle xrayContext)
    {
        var linkedTestSummariesByKey = BuildLinkedTestSummaryMap(jira, xrayContext);
        var coverageByKey = new Dictionary<string, string?>(linkedTestSummariesByKey, StringComparer.OrdinalIgnoreCase);

        foreach (var test in xrayContext.NeighboringTests)
        {
            if (!coverageByKey.TryGetValue(test.IssueKey, out var summary) || string.IsNullOrWhiteSpace(summary))
            {
                coverageByKey[test.IssueKey] = test.Summary;
            }
        }

        if (coverageByKey.Count == 0)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        builder.AppendLine("Review every candidate scenario against this index before proposing net-new coverage.");
        builder.AppendLine("If a scenario overlaps any indexed test title or behavior, reuse that Xray key instead of creating a duplicate.");
        foreach (var coverage in coverageByKey.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase))
        {
            builder.AppendLine($"- {coverage.Key}: {coverage.Value ?? "Title unavailable"}");
        }

        return builder.ToString().Trim();
    }

    private static string BuildXrayTestsSection(XrayContextBundle xrayContext)
    {
        if (xrayContext.NeighboringTests.Count == 0)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        foreach (var test in xrayContext.NeighboringTests)
        {
            builder.AppendLine($"Xray Test: {test.IssueKey} - {test.Summary}");
            builder.AppendLine($"Test Type: {test.TestType}");
            builder.AppendLine("Coverage Guidance: Reuse this existing Xray test if the generated scenario covers the same behavior.");
            if (test.Labels.Count > 0)
            {
                builder.AppendLine($"Labels: {string.Join(", ", test.Labels)}");
            }

            if (!string.IsNullOrWhiteSpace(test.Gherkin))
            {
                builder.AppendLine("Gherkin:");
                builder.AppendLine(test.Gherkin.Trim());
            }

            if (test.Steps.Count > 0)
            {
                builder.AppendLine("Manual Steps:");
                foreach (var step in test.Steps)
                {
                    builder.AppendLine($"- Action: {step.Action}");
                    if (!string.IsNullOrWhiteSpace(step.Data))
                    {
                        builder.AppendLine($"  Data: {step.Data}");
                    }

                    if (!string.IsNullOrWhiteSpace(step.Result))
                    {
                        builder.AppendLine($"  Result: {step.Result}");
                    }
                }
            }

            builder.AppendLine();
        }

        return builder.ToString().Trim();
    }

    private static string BuildOutputContractSection(NormalizedRunRequest request)
    {
        var builder = new StringBuilder();
        builder.AppendLine("Return structured JSON only in later generation stages.");
        builder.AppendLine($"Workflow pass: {request.WorkflowPass}");
        builder.Append($"Requested scope: {request.TestScope}");
        return builder.ToString().Trim();
    }

    private static string FormatPullRequestReferences(RepositoryTarget? repositoryTarget)
    {
        if (repositoryTarget is null)
        {
            return "Not available";
        }

        if (repositoryTarget.EffectivePullRequestReferences.Count > 0)
        {
            return string.Join(", ", repositoryTarget.EffectivePullRequestReferences);
        }

        return repositoryTarget.PrimaryPullRequestReference ?? "Not available";
    }

    private static void AddSectionIfNotEmpty(
        ICollection<GenerationContextSection> sections,
        string key,
        string title,
        string content)
    {
        if (!string.IsNullOrWhiteSpace(content))
        {
            sections.Add(new GenerationContextSection(key, title, content));
        }
    }

    private static void AddSectionOrWarning(
        ICollection<GenerationContextSection> sections,
        ICollection<RunWarning> warnings,
        string key,
        string title,
        string content,
        string warningCode,
        string warningMessage)
    {
        if (!string.IsNullOrWhiteSpace(content))
        {
            sections.Add(new GenerationContextSection(key, title, content));
            return;
        }

        warnings.Add(new RunWarning(warningCode, warningMessage));
    }

    private static string FormatOrDefault(string value)
        => string.IsNullOrWhiteSpace(value) ? "Not specified" : value;

    private static string FormatOrDefault(IReadOnlyList<string> values)
        => values.Count == 0 ? "Not specified" : string.Join(", ", values);

    private static Dictionary<string, string?> BuildLinkedTestSummaryMap(
        JiraIssueContext jira,
        XrayContextBundle xrayContext)
    {
        var linkedTestSummariesByKey = jira.LinkedIssues
            .Where(IsLinkedTestIssue)
            .Where(linkedIssue => !string.IsNullOrWhiteSpace(linkedIssue.IssueKey))
            .GroupBy(linkedIssue => linkedIssue.IssueKey, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(
                group => group.Key,
                group => group.Select(linkedIssue => linkedIssue.Summary)
                    .FirstOrDefault(summary => !string.IsNullOrWhiteSpace(summary)),
                StringComparer.OrdinalIgnoreCase);

        foreach (var test in xrayContext.NeighboringTests)
        {
            if (!linkedTestSummariesByKey.ContainsKey(test.IssueKey))
            {
                continue;
            }

            if (string.IsNullOrWhiteSpace(linkedTestSummariesByKey[test.IssueKey]))
            {
                linkedTestSummariesByKey[test.IssueKey] = test.Summary;
            }
        }

        return linkedTestSummariesByKey;
    }

    private static bool IsLinkedTestIssue(JiraLinkedIssue linkedIssue)
        => linkedIssue.IssueType.Equals("Test", StringComparison.OrdinalIgnoreCase) ||
           linkedIssue.IssueType.Equals("Test Case", StringComparison.OrdinalIgnoreCase);
}
