using System.Text;
using Manso.Domain;
using Microsoft.Extensions.Logging;

namespace Manso.Application;

public sealed class GenerationContextBundleBuilder : IGenerationContextBundleBuilder
{
    private readonly GenerationContextOptions _options;
    private readonly ILogger<GenerationContextBundleBuilder> _logger;

    public GenerationContextBundleBuilder(
        GenerationContextOptions options,
        ILogger<GenerationContextBundleBuilder> logger)
    {
        _options = options;
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

        var acceptanceCriteriaSection = BuildAcceptanceCriteriaSection(jira);
        if (!string.IsNullOrWhiteSpace(acceptanceCriteriaSection))
        {
            sections.Add(new GenerationContextSection(
                "acceptance_criteria",
                "ACCEPTANCE CRITERIA",
                acceptanceCriteriaSection));
        }

        var commentsSection = BuildCommentsSection(jira.Comments);
        if (!string.IsNullOrWhiteSpace(commentsSection))
        {
            sections.Add(new GenerationContextSection(
                "selected_comments",
                "SELECTED COMMENTS",
                commentsSection));
        }

        var docsSection = BuildDocumentationSection(documents);
        if (!string.IsNullOrWhiteSpace(docsSection))
        {
            sections.Add(new GenerationContextSection(
                "explicit_confluence_docs",
                "EXPLICIT CONFLUENCE DOCS",
                docsSection));
        }

        var repoSummary = BuildRepositorySummarySection(repositoryTarget, repositoryContext);
        sections.Add(new GenerationContextSection(
            "repo_change_summary",
            "REPO CHANGE SUMMARY",
            repoSummary));

        var changedCodeSection = BuildChangedCodeSection(repositoryContext);
        if (!string.IsNullOrWhiteSpace(changedCodeSection))
        {
            sections.Add(new GenerationContextSection(
                "changed_code_excerpts",
                "CHANGED CODE EXCERPTS",
                changedCodeSection));
        }
        else
        {
            warnings.Add(new RunWarning(
                "generation_context_without_code_diff",
                "Generation context was built without repository diff excerpts."));
        }

        var neighboringTestsSection = BuildNeighboringTestsSection(repositoryContext);
        if (!string.IsNullOrWhiteSpace(neighboringTestsSection))
        {
            sections.Add(new GenerationContextSection(
                "neighboring_test_patterns",
                "NEIGHBORING TEST PATTERNS",
                neighboringTestsSection));
        }
        else
        {
            warnings.Add(new RunWarning(
                "generation_context_without_neighboring_tests",
                "Generation context was built without neighboring test patterns."));
        }

        var xrayTestsSection = BuildXrayTestsSection(xrayContext);
        if (!string.IsNullOrWhiteSpace(xrayTestsSection))
        {
            sections.Add(new GenerationContextSection(
                "xray_neighboring_tests",
                "XRAY NEIGHBORING TESTS",
                xrayTestsSection));
        }

        var conventionsSection = BuildRepositoryConventionsSection(repositoryContext);
        if (!string.IsNullOrWhiteSpace(conventionsSection))
        {
            sections.Add(new GenerationContextSection(
                "repo_test_conventions",
                "REPO TEST CONVENTIONS",
                conventionsSection));
        }

        sections.Add(new GenerationContextSection(
            "output_contract",
            "OUTPUT CONTRACT",
            BuildOutputContractSection(request)));

        var bundle = new GenerationContextBundle(
            new RunMetadataContext(
                request.IssueKey,
                request.GenerationMode,
                request.TestScope,
                request.CoverageIntent,
                request.OutputTarget,
                repositoryTarget?.Alias ?? request.RepositoryAlias,
                repositoryTarget?.PullRequestReference,
                repositoryTarget),
            sections,
            warnings.Concat(xrayContext.Warnings).ToArray(),
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
        builder.AppendLine($"Generation Mode: {request.GenerationMode}");
        builder.AppendLine($"Test Scope: {request.TestScope}");
        builder.AppendLine($"Coverage Intent: {request.CoverageIntent}");
        builder.AppendLine($"Output Target: {request.OutputTarget}");
        builder.AppendLine($"Documentation Mode: {request.DocumentationMode}");
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
        => string.IsNullOrWhiteSpace(jira.AcceptanceCriteria)
            ? string.Empty
            : jira.AcceptanceCriteria.Trim();

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
        builder.Append($"Formatter Commands: {FormatOrDefault(conventions.FormatterCommands)}");
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
        builder.AppendLine($"Requested scope: {request.TestScope}");
        builder.AppendLine($"Requested coverage intent: {request.CoverageIntent}");
        builder.Append($"Generation mode: {request.GenerationMode}");
        return builder.ToString().Trim();
    }

    private static string FormatPullRequestReferences(RepositoryTarget? repositoryTarget)
    {
        if (repositoryTarget is null)
        {
            return "Not available";
        }

        if (repositoryTarget.PullRequestReferences.Count > 0)
        {
            return string.Join(", ", repositoryTarget.PullRequestReferences);
        }

        return repositoryTarget.PullRequestReference ?? "Not available";
    }

    private static string FormatOrDefault(string value)
        => string.IsNullOrWhiteSpace(value) ? "Not specified" : value;

    private static string FormatOrDefault(IReadOnlyList<string> values)
        => values.Count == 0 ? "Not specified" : string.Join(", ", values);
}
