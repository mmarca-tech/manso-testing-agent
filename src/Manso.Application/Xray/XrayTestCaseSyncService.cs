using System.Text;
using System.Text.RegularExpressions;
using Manso.Domain;
using Microsoft.Extensions.Logging;

namespace Manso.Application;

public sealed class XrayTestCaseSyncService : IXrayTestCaseSyncService
{
    private static readonly string[] ComponentRootSegments =
    [
        "src",
        "source",
        "tests",
        "test",
        "spec",
        "specs",
    ];
    private static readonly Regex XrayIssueKeyRegex = new(@"\b[A-Z][A-Z0-9_]*-T\d+\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private readonly IXrayApiClient _xrayApiClient;
    private readonly IJiraApiClient _jiraApiClient;
    private readonly XrayRetrievalOptions _options;
    private readonly ILogger<XrayTestCaseSyncService> _logger;

    public XrayTestCaseSyncService(
        IXrayApiClient xrayApiClient,
        IJiraApiClient jiraApiClient,
        XrayRetrievalOptions options,
        ILogger<XrayTestCaseSyncService> logger)
    {
        _xrayApiClient = xrayApiClient;
        _jiraApiClient = jiraApiClient;
        _options = options;
        _logger = logger;
    }

    public async Task<XrayScenarioSyncResult> SyncAsync(
        NormalizedRunRequest request,
        JiraIssueContext issue,
        GeneratedScenarioBundle scenarios,
        RepositoryContextBundle? repositoryContext,
        XrayContextBundle xrayContext,
        CancellationToken ct)
    {
        var items = new List<XrayScenarioSyncItem>();
        var warnings = new List<RunWarning>();
        var componentTestSet = await ResolveComponentTestSetAsync(request, issue, repositoryContext, warnings, ct);

        foreach (var scenario in scenarios.Scenarios)
        {
            ct.ThrowIfCancellationRequested();

            var match = MatchScenario(scenario, xrayContext.NeighboringTests);
            if (match.Kind == MatchKind.Ambiguous)
            {
                var reason = $"Scenario '{scenario.ScenarioId}' matched multiple Xray tests and was not synced automatically.";
                warnings.Add(new RunWarning("xray_ambiguous_match", reason));
                items.Add(new XrayScenarioSyncItem(
                    scenario.ScenarioId,
                    scenario.Title,
                    "AmbiguousMatch",
                    null,
                    null,
                    reason,
                    null,
                    componentTestSet?.IssueKey));
                continue;
            }

            var upsertRequest = BuildUpsertRequest(issue, scenario, match.TestCase);
            var result = await _xrayApiClient.UpsertTestCaseAsync(upsertRequest, ct);
            var action = upsertRequest.ExistingIssueId is null ? "Created" : "Updated";

            await _jiraApiClient.EnsureTestCoverageLinkAsync(issue.IssueKey, result.IssueKey, ct);
            if (componentTestSet is not null)
            {
                await _xrayApiClient.AddTestsToTestSetAsync(
                    new XrayAssociationUpdateRequest(
                        componentTestSet.IssueId,
                        [result.IssueId]),
                    ct);
            }

            items.Add(new XrayScenarioSyncItem(
                scenario.ScenarioId,
                scenario.Title,
                action,
                result.IssueId,
                result.IssueKey,
                match.Kind == MatchKind.Matched
                    ? $"Matched existing Xray test '{match.TestCase!.IssueKey}'."
                    : "Created new Xray test case from generated scenario.",
                issue.IssueKey,
                componentTestSet?.IssueKey));
        }

        _logger.LogInformation(
            "Synchronized {ScenarioCount} generated scenario(s) to Xray. CreatedOrUpdatedCount: {SyncedCount}. WarningCount: {WarningCount}.",
            scenarios.Scenarios.Count,
            items.Count(item => item.Action is "Created" or "Updated"),
            warnings.Count);

        return new XrayScenarioSyncResult(items, warnings);
    }

    private XrayTestCaseUpsertRequest BuildUpsertRequest(
        JiraIssueContext issue,
        GeneratedScenario scenario,
        XrayTestCase? existingTest)
    {
        var labels = issue.Labels
            .Concat(["ai-testgen"])
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var targetType = DetermineTargetTestType(existingTest);

        return new XrayTestCaseUpsertRequest(
            ResolveProjectKey(issue.IssueKey),
            scenario.Title,
            BuildScenarioDescription(issue, scenario),
            targetType,
            targetType.Equals("Cucumber", StringComparison.OrdinalIgnoreCase) ? scenario.Gherkin : null,
            targetType.Equals("Manual", StringComparison.OrdinalIgnoreCase)
                ? BuildManualSteps(scenario)
                : Array.Empty<XrayTestStep>(),
            labels,
            existingTest?.IssueId);
    }

    private string DetermineTargetTestType(XrayTestCase? existingTest)
    {
        if (existingTest is null)
        {
            return _options.DefaultCreatedTestType;
        }

        if (existingTest.TestType.Equals("Manual", StringComparison.OrdinalIgnoreCase))
        {
            return "Manual";
        }

        if (existingTest.TestType.Equals("Generic", StringComparison.OrdinalIgnoreCase))
        {
            return "Generic";
        }

        return "Cucumber";
    }

    private string ResolveProjectKey(string issueKey)
    {
        if (!string.IsNullOrWhiteSpace(issueKey))
        {
            var separatorIndex = issueKey.IndexOf('-', StringComparison.Ordinal);
            if (separatorIndex > 0)
            {
                return issueKey[..separatorIndex].Trim().ToUpperInvariant();
            }
        }

        throw new InvalidOperationException(
            $"Unable to resolve Xray project key from issue key '{issueKey}'.");
    }

    private static string BuildScenarioDescription(
        JiraIssueContext issue,
        GeneratedScenario scenario)
    {
        var builder = new StringBuilder();
        builder.AppendLine($"Generated from Jira issue {issue.IssueKey}: {issue.Summary}");
        builder.AppendLine();
        builder.AppendLine($"Scenario ID: {scenario.ScenarioId}");
        builder.AppendLine($"Priority: {scenario.Priority}");
        builder.AppendLine($"Suggested Level: {scenario.SuggestedLevel}");
        builder.AppendLine($"Source Acceptance Criteria: {string.Join(", ", scenario.SourceAcceptanceCriteriaRefs)}");
        builder.AppendLine($"Risk Rationale: {scenario.RiskRationale}");
        if (scenario.Preconditions.Count > 0)
        {
            builder.AppendLine("Preconditions:");
            foreach (var precondition in scenario.Preconditions)
            {
                builder.AppendLine($"- {precondition}");
            }
        }

        builder.AppendLine();
        builder.AppendLine("Gherkin:");
        builder.AppendLine(scenario.Gherkin);
        builder.AppendLine();
        builder.AppendLine($"Expected Outcome: {scenario.ExpectedOutcome}");
        builder.AppendLine($"Duplicate Assessment: {scenario.DuplicateAssessment}");
        return builder.ToString().Trim();
    }

    private static IReadOnlyList<XrayTestStep> BuildManualSteps(GeneratedScenario scenario)
    {
        var steps = scenario.Gherkin
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Split('\n')
            .Select(line => line.Trim())
            .Where(line => !string.IsNullOrWhiteSpace(line))
            .Where(line => !line.StartsWith("Scenario:", StringComparison.OrdinalIgnoreCase))
            .Select(line => new XrayTestStep(line, null, null))
            .ToList();

        if (steps.Count == 0)
        {
            steps.Add(new XrayTestStep(scenario.Title, null, scenario.ExpectedOutcome));
            return steps;
        }

        steps[^1] = steps[^1] with { Result = scenario.ExpectedOutcome };
        return steps;
    }

    private async Task<XrayTestSet?> ResolveComponentTestSetAsync(
        NormalizedRunRequest request,
        JiraIssueContext issue,
        RepositoryContextBundle? repositoryContext,
        List<RunWarning> warnings,
        CancellationToken ct)
    {
        var componentName = InferComponentName(repositoryContext);
        if (string.IsNullOrWhiteSpace(componentName))
        {
            warnings.Add(new RunWarning(
                "xray_component_not_inferred",
                "Skipping Xray test-set assignment because no stable component could be inferred from repository paths."));
            return null;
        }

        var projectKey = ResolveProjectKey(issue.IssueKey);
        var repositoryName = repositoryContext?.Target.RepositoryName
                             ?? request.RepositoryAlias
                             ?? "repo";
        var testSetSummary = $"{repositoryName} - {componentName} Test Set";
        var searchRequest = new XrayTestSetSearchRequest(
            $"project = {projectKey} AND issuetype = \"Test Set\" AND summary ~ \"\\\"{EscapeJqlLiteral(testSetSummary)}\\\"\" ORDER BY updated DESC",
            5);
        var existing = await _xrayApiClient.SearchTestSetsAsync(searchRequest, ct);
        var exactMatch = existing.FirstOrDefault(testSet =>
            testSet.Summary.Equals(testSetSummary, StringComparison.OrdinalIgnoreCase));
        if (exactMatch is not null)
        {
            return exactMatch;
        }

        var labels = issue.Labels
            .Concat(["ai-testgen", BuildComponentLabel(componentName)])
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var created = await _xrayApiClient.CreateTestSetAsync(
            new XrayTestSetCreateRequest(
                projectKey,
                testSetSummary,
                $"Component-based test set for repository '{repositoryName}' and component '{componentName}'.",
                labels),
            ct);

        return new XrayTestSet(created.IssueId, created.IssueKey, testSetSummary);
    }

    private static string? InferComponentName(RepositoryContextBundle? repositoryContext)
    {
        if (repositoryContext is null || repositoryContext.ChangedFiles.Count == 0)
        {
            return null;
        }

        var candidatePaths = repositoryContext.ChangedFiles
            .Where(change => !change.IsTestFile)
            .Select(change => change.Path)
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .ToArray();
        if (candidatePaths.Length == 0)
        {
            candidatePaths = repositoryContext.ChangedFiles
                .Select(change => change.Path)
                .Where(path => !string.IsNullOrWhiteSpace(path))
                .ToArray();
        }

        var rankedComponents = candidatePaths
            .Select(TryExtractComponentFromPath)
            .Where(component => !string.IsNullOrWhiteSpace(component))
            .GroupBy(component => component!, StringComparer.OrdinalIgnoreCase)
            .Select(group => new
            {
                Component = group.Key,
                Count = group.Count(),
            })
            .OrderByDescending(group => group.Count)
            .ThenBy(group => group.Component, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        if (rankedComponents.Length == 0)
        {
            return null;
        }

        if (rankedComponents.Length > 1 && rankedComponents[0].Count == rankedComponents[1].Count)
        {
            return null;
        }

        return rankedComponents[0].Component;
    }

    private static string? TryExtractComponentFromPath(string path)
    {
        var segments = path
            .Split(['/', '\\'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (segments.Length == 0)
        {
            return null;
        }

        var rootIndex = Array.FindIndex(segments, segment =>
            ComponentRootSegments.Contains(segment, StringComparer.OrdinalIgnoreCase));
        if (rootIndex >= 0 && rootIndex + 1 < segments.Length)
        {
            return NormalizeComponentName(segments[rootIndex + 1]);
        }

        return segments.Length > 1
            ? NormalizeComponentName(segments[0])
            : null;
    }

    private static string? NormalizeComponentName(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var trimmed = value.Trim('/', '\\').Trim();
        return string.IsNullOrWhiteSpace(trimmed)
            ? null
            : trimmed;
    }

    private static string BuildComponentLabel(string componentName)
        => $"component-{NormalizeForMatch(componentName).Replace(" ", "-", StringComparison.Ordinal)}";

    private static string EscapeJqlLiteral(string value)
        => value.Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal);

    private static MatchResult MatchScenario(
        GeneratedScenario scenario,
        IReadOnlyList<XrayTestCase> candidates)
    {
        var explicitIssueKey = ResolveExplicitExistingIssueKey(scenario);
        if (!string.IsNullOrWhiteSpace(explicitIssueKey))
        {
            var explicitMatch = candidates.FirstOrDefault(candidate =>
                candidate.IssueKey.Equals(explicitIssueKey, StringComparison.OrdinalIgnoreCase));
            if (explicitMatch is not null)
            {
                return new MatchResult(MatchKind.Matched, explicitMatch);
            }
        }

        var ranked = candidates
            .Select(candidate => new
            {
                Candidate = candidate,
                Score = ScoreScenarioMatch(scenario, candidate),
            })
            .Where(item => item.Score >= 70)
            .OrderByDescending(item => item.Score)
            .ThenBy(item => item.Candidate.IssueKey, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        if (ranked.Length == 0)
        {
            return new MatchResult(MatchKind.NoMatch, null);
        }

        if (ranked.Length > 1 && ranked[0].Score - ranked[1].Score < 15)
        {
            return new MatchResult(MatchKind.Ambiguous, null);
        }

        return new MatchResult(MatchKind.Matched, ranked[0].Candidate);
    }

    private static string? ResolveExplicitExistingIssueKey(GeneratedScenario scenario)
    {
        if (!string.IsNullOrWhiteSpace(scenario.ExistingXrayIssueKey))
        {
            return scenario.ExistingXrayIssueKey.Trim();
        }

        var match = XrayIssueKeyRegex.Match(scenario.DuplicateAssessment ?? string.Empty);
        return match.Success ? match.Value : null;
    }

    private static int ScoreScenarioMatch(GeneratedScenario scenario, XrayTestCase candidate)
    {
        var score = 0;
        var scenarioTitle = NormalizeForMatch(scenario.Title);
        var candidateSummary = NormalizeForMatch(candidate.Summary);
        var scenarioGherkin = NormalizeForMatch(scenario.Gherkin);
        var candidateGherkin = NormalizeForMatch(candidate.Gherkin ?? string.Empty);

        if (scenarioTitle == candidateSummary)
        {
            score += 100;
        }
        else if (scenarioTitle.Contains(candidateSummary, StringComparison.Ordinal) ||
                 candidateSummary.Contains(scenarioTitle, StringComparison.Ordinal))
        {
            score += 80;
        }

        if (!string.IsNullOrWhiteSpace(candidateGherkin) && scenarioGherkin == candidateGherkin)
        {
            score += 95;
        }

        if (scenario.SourceAcceptanceCriteriaRefs.Any(reference =>
                candidate.Labels.Contains(reference, StringComparer.OrdinalIgnoreCase)))
        {
            score += 10;
        }

        return score;
    }

    private static string NormalizeForMatch(string value)
        => Regex.Replace(value ?? string.Empty, "[^a-z0-9]+", " ", RegexOptions.IgnoreCase)
            .Trim()
            .ToLowerInvariant();

    private enum MatchKind
    {
        NoMatch,
        Matched,
        Ambiguous,
    }

    private sealed record MatchResult(
        MatchKind Kind,
        XrayTestCase? TestCase);
}
