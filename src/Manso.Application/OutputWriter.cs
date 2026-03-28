using System.Text;
using System.Text.Json;
using Manso.Domain;
using Microsoft.Extensions.Logging;

namespace Manso.Application;

public sealed class OutputWriter : IOutputWriter
{
    private readonly IScmClient _scmClient;
    private readonly ILogger<OutputWriter> _logger;

    public OutputWriter(
        IScmClient scmClient,
        ILogger<OutputWriter> logger)
    {
        _scmClient = scmClient;
        _logger = logger;
    }

    public async Task<OutputWriteResult> WriteAsync(
        GenerationContextBundle bundle,
        GeneratedScenarioBundle scenarios,
        GeneratedCodeBundle? code,
        ValidationResult validation,
        CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var artifacts = new List<StoredArtifact>();

        var scenarioMarkdown = RenderScenarioMarkdown(bundle, scenarios, validation);
        artifacts.Add(new StoredArtifact(
            "ScenarioMarkdown",
            "generated-scenarios.md",
            "text/markdown",
            $"run://{bundle.Metadata.IssueKey}/generated-scenarios.md",
            scenarioMarkdown));

        if (code is not null)
        {
            artifacts.Add(new StoredArtifact(
                "GeneratedCodeBundleJson",
                "generated-code-bundle.json",
                "application/json",
                $"run://{bundle.Metadata.IssueKey}/generated-code-bundle.json",
                JsonSerializer.Serialize(code)));
        }

        RepositoryWritePlan? writePlan = null;
        RepositoryWriteExecutionResult? writeExecution = null;
        var writeStatus = DetermineWriteStatus(bundle, validation, code);

        if (ShouldCreateWritePlan(bundle, validation, code))
        {
            writePlan = BuildWritePlan(bundle, scenarios, code!);
            artifacts.Add(new StoredArtifact(
                "RepositoryWritePlanJson",
                "repository-write-plan.json",
                "application/json",
                $"run://{bundle.Metadata.IssueKey}/repository-write-plan.json",
                JsonSerializer.Serialize(writePlan)));

            _logger.LogInformation(
                "Writing generated outputs for issue {IssueKey} to repository {RepositoryAlias} on branch {BranchName}.",
                bundle.Metadata.IssueKey,
                writePlan.RepositoryAlias,
                writePlan.NewBranchName);

            writeExecution = await _scmClient.WriteAsync(bundle.Metadata.RepositoryTarget!, writePlan, ct);
            writeStatus = "DraftPullRequestCreated";
        }

        var writeResult = new WriteResult(
            bundle.Metadata.OutputTarget,
            writeStatus,
            writeExecution?.BranchName ?? writePlan?.NewBranchName,
            writeExecution?.PullRequestUrl,
            artifacts.Select(artifact => new ArtifactReference(
                artifact.Type,
                artifact.Name,
                artifact.ContentType,
                artifact.Content.Length,
                artifact.Location)).ToArray());

        artifacts.Add(new StoredArtifact(
            "WriteResultJson",
            "write-result.json",
            "application/json",
            $"run://{bundle.Metadata.IssueKey}/write-result.json",
            JsonSerializer.Serialize(writeResult)));

        return new OutputWriteResult(writeResult, artifacts);
    }

    private static string DetermineWriteStatus(
        GenerationContextBundle bundle,
        ValidationResult validation,
        GeneratedCodeBundle? code)
    {
        if (validation.Outcome == ValidationOutcome.Fail)
        {
            return "ValidationFailedArtifactsOnly";
        }

        if (code is null || code.Files.Count == 0)
        {
            return "ArtifactsStoredNoRepoWrite";
        }

        if (bundle.Metadata.OutputTarget == OutputTarget.JiraComment)
        {
            return "RepoWriteSkippedOutputTargetJiraComment";
        }

        if (bundle.Metadata.RepositoryTarget is null)
        {
            return "RepoWriteSkippedMissingRepositoryTarget";
        }

        return "WriteDeferred";
    }

    private static bool ShouldCreateWritePlan(
        GenerationContextBundle bundle,
        ValidationResult validation,
        GeneratedCodeBundle? code)
        => validation.Outcome is ValidationOutcome.Pass or ValidationOutcome.PassWithWarnings
           && code is not null
           && code.Files.Count > 0
           && bundle.Metadata.OutputTarget is OutputTarget.DraftPullRequest or OutputTarget.Both
           && bundle.Metadata.RepositoryTarget is not null;

    private static RepositoryWritePlan BuildWritePlan(
        GenerationContextBundle bundle,
        GeneratedScenarioBundle scenarios,
        GeneratedCodeBundle code)
    {
        var repositoryTarget = bundle.Metadata.RepositoryTarget
                               ?? throw new InvalidOperationException("Repository target is required for repo writes.");
        var baseBranch = string.IsNullOrWhiteSpace(repositoryTarget.BaseBranch)
            ? repositoryTarget.DefaultBranch
            : repositoryTarget.BaseBranch;

        return new RepositoryWritePlan(
            repositoryTarget.Alias,
            baseBranch,
            BuildBranchName(bundle.Metadata.IssueKey, scenarios),
            $"test(ai): generate tests for {bundle.Metadata.IssueKey}",
            code.Files,
            $"[AI TestGen] {bundle.Metadata.IssueKey} - generated test updates",
            BuildPullRequestBody(bundle, scenarios, code, baseBranch),
            CreateDraftPullRequest: true);
    }

    private static string BuildBranchName(
        string issueKey,
        GeneratedScenarioBundle scenarios)
    {
        var purpose = scenarios.Scenarios.Count == 0
            ? "generated-tests"
            : BuildSlug(scenarios.Scenarios[0].Title);
        if (!purpose.EndsWith("-tests", StringComparison.OrdinalIgnoreCase))
        {
            purpose += "-tests";
        }

        return $"ai-testgen/{issueKey.ToUpperInvariant()}/{purpose}";
    }

    private static string BuildPullRequestBody(
        GenerationContextBundle bundle,
        GeneratedScenarioBundle scenarios,
        GeneratedCodeBundle code,
        string baseBranch)
    {
        var builder = new StringBuilder();
        builder.AppendLine("## AI TestGen Summary");
        builder.AppendLine();
        builder.AppendLine($"- Issue: {bundle.Metadata.IssueKey}");
        builder.AppendLine($"- Generation mode: {bundle.Metadata.GenerationMode}");
        builder.AppendLine($"- Test scope: {bundle.Metadata.TestScope}");
        builder.AppendLine($"- Coverage intent: {bundle.Metadata.CoverageIntent}");
        builder.AppendLine($"- Base branch: {baseBranch}");
        builder.AppendLine($"- Generated file count: {code.Files.Count}");
        builder.AppendLine($"- Scenario count: {scenarios.Scenarios.Count}");
        builder.AppendLine();
        builder.AppendLine("## Coverage Summary");
        builder.AppendLine();
        builder.AppendLine(string.IsNullOrWhiteSpace(code.CoverageSummary)
            ? "No explicit coverage summary was provided."
            : code.CoverageSummary.Trim());
        builder.AppendLine();
        builder.AppendLine("## Generated Files");
        builder.AppendLine();
        foreach (var file in code.Files.OrderBy(file => file.Path, StringComparer.OrdinalIgnoreCase))
        {
            builder.AppendLine($"- `{file.Action}` `{file.Path}`");
        }

        if (bundle.Warnings.Count > 0)
        {
            builder.AppendLine();
            builder.AppendLine("## Run Warnings");
            builder.AppendLine();
            foreach (var warning in bundle.Warnings)
            {
                builder.AppendLine($"- `{warning.Code}` {warning.Message}");
            }
        }

        builder.AppendLine();
        builder.AppendLine("## Review Notice");
        builder.AppendLine();
        builder.AppendLine("This draft PR was generated by AI and requires human review before merge.");
        return builder.ToString().Trim();
    }

    private static string BuildSlug(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "generated-tests";
        }

        var builder = new StringBuilder();
        var previousWasSeparator = false;
        foreach (var ch in value.ToLowerInvariant())
        {
            if (char.IsLetterOrDigit(ch))
            {
                builder.Append(ch);
                previousWasSeparator = false;
                continue;
            }

            if (previousWasSeparator)
            {
                continue;
            }

            builder.Append('-');
            previousWasSeparator = true;
        }

        var slug = builder.ToString().Trim('-');
        if (slug.Length > 48)
        {
            slug = slug[..48].TrimEnd('-');
        }

        return string.IsNullOrWhiteSpace(slug)
            ? "generated-tests"
            : slug;
    }

    private static string RenderScenarioMarkdown(
        GenerationContextBundle bundle,
        GeneratedScenarioBundle scenarios,
        ValidationResult validation)
    {
        var builder = new StringBuilder();
        builder.AppendLine($"# Scenario Output for {bundle.Metadata.IssueKey}");
        builder.AppendLine();
        builder.AppendLine($"- Generation mode: {bundle.Metadata.GenerationMode}");
        builder.AppendLine($"- Test scope: {bundle.Metadata.TestScope}");
        builder.AppendLine($"- Coverage intent: {bundle.Metadata.CoverageIntent}");
        builder.AppendLine($"- Validation outcome: {validation.Outcome}");
        builder.AppendLine($"- Scenario count: {scenarios.Scenarios.Count}");
        builder.AppendLine();

        foreach (var scenario in scenarios.Scenarios)
        {
            builder.AppendLine($"## {scenario.ScenarioId} - {scenario.Title}");
            builder.AppendLine();
            builder.AppendLine($"- Priority: {scenario.Priority}");
            builder.AppendLine($"- Suggested level: {scenario.SuggestedLevel}");
            builder.AppendLine($"- Source refs: {string.Join(", ", scenario.SourceAcceptanceCriteriaRefs)}");
            builder.AppendLine($"- Risk rationale: {scenario.RiskRationale}");
            if (scenario.Preconditions.Count > 0)
            {
                builder.AppendLine("- Preconditions:");
                foreach (var precondition in scenario.Preconditions)
                {
                    builder.AppendLine($"  - {precondition}");
                }
            }

            builder.AppendLine();
            builder.AppendLine("### Gherkin");
            builder.AppendLine("```gherkin");
            builder.AppendLine(scenario.Gherkin);
            builder.AppendLine("```");
            builder.AppendLine();
            builder.AppendLine($"Expected outcome: {scenario.ExpectedOutcome}");
            builder.AppendLine($"Duplicate assessment: {scenario.DuplicateAssessment}");
            builder.AppendLine();
        }

        if (validation.Messages.Count > 0)
        {
            builder.AppendLine("## Validation Messages");
            builder.AppendLine();
            foreach (var message in validation.Messages)
            {
                builder.AppendLine($"- [{message.Severity}] {message.Code}: {message.Message}");
            }
        }

        return builder.ToString().Trim();
    }
}
