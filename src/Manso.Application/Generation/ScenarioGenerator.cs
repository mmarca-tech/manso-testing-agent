using Manso.Domain;
using Microsoft.Extensions.Logging;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Manso.Application;

public sealed class ScenarioGenerator : IScenarioGenerator
{
    private static readonly JsonSerializerOptions JsonSerializerOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };

    private readonly ILlmGateway _llmGateway;
    private readonly ScenarioGenerationOptions _options;
    private readonly ILogger<ScenarioGenerator> _logger;

    public ScenarioGenerator(
        ILlmGateway llmGateway,
        ScenarioGenerationOptions options,
        ILogger<ScenarioGenerator> logger)
    {
        _llmGateway = llmGateway;
        _options = options;
        _logger = logger;
    }

    public async Task<GeneratedScenarioBundle> GenerateAsync(
        GenerationContextBundle bundle,
        CancellationToken ct)
    {
        var promptRequest = PreviewPrompt(bundle);
        var completion = await _llmGateway.CompleteJsonAsync(promptRequest, ct);

        var parsed = ParseScenarioOutput(completion);
        Validate(parsed, bundle);

        _logger.LogInformation(
            "Generated {ScenarioCount} scenario(s) using provider {Provider} and model {Model}.",
            parsed.Scenarios.Count,
            parsed.ModelProvider,
            parsed.ModelName);

        return parsed;
    }

    public LlmPromptRequest PreviewPrompt(GenerationContextBundle bundle)
        => BuildPrompt(bundle);

    private LlmPromptRequest BuildPrompt(GenerationContextBundle bundle)
    {
        var systemPrompt =
            """
            You are generating candidate automated test scenarios.

            Rules:
            - Output JSON only.
            - Ground every scenario in the provided context.
            - Prefer behavior visible in acceptance criteria and changed code.
            - If repository diff is missing, rely on Jira and explicit documentation only.
            - Do not invent unsupported product behavior.
            - Match the requested scope unless the context makes that impossible.
            - Every scenario must state why it exists.
            - Follow the RUNTIME GUARDRAILS section as operational policy for this run.
            - When the ACCEPTANCE CRITERIA section is present, sourceAcceptanceCriteriaRefs must cite one or more exact AC-* references from that section.
            - When the ACCEPTANCE CRITERIA section is absent, leave sourceAcceptanceCriteriaRefs empty instead of inventing AC-* references.
            - Review the EXISTING XRAY COVERAGE INDEX section before writing any scenario.
            - duplicateAssessment must explicitly state whether the scenario reuses an indexed Xray test or is net-new after comparison against the existing coverage index.
            - Review the EXISTING LINKED XRAY TESTS section first and treat those titles as the strongest duplicate signal for this ticket.
            - Review the XRAY NEIGHBORING TESTS section as existing coverage, including manually created tests.
            - If a candidate scenario title or covered behavior substantially overlaps an existing linked Xray test title, do not propose it as net-new coverage.
            - Do not create duplicate scenarios for behavior that is already covered by an existing Xray test.
            - When a scenario is already covered by an existing Xray test, set existingXrayIssueKey to that exact Xray key.
            - existingXrayIssueKey must be a real Jira/Xray issue key from the same project as the tested issue, for example RM-15905 when the tested issue is RM-15888.
            - Never place external identifiers, Postman IDs, business IDs, or case codes in existingXrayIssueKey.
            - Prefer referencing the exact linked Xray title and key in duplicateAssessment when you mark a scenario as already covered.
            - Only leave existingXrayIssueKey empty when the scenario is genuinely net-new coverage.
            """;

        var userBuilder = new StringBuilder();
        userBuilder.AppendLine("Generate candidate automated test scenarios from the following structured context.");
        userBuilder.AppendLine($"Return between {_options.MinScenarios} and {_options.MaxScenarios} scenarios.");
        userBuilder.AppendLine();

        foreach (var section in bundle.Sections)
        {
            userBuilder.AppendLine($"### {section.Title}");
            userBuilder.AppendLine(section.Content);
            userBuilder.AppendLine();
        }

        userBuilder.AppendLine("### OUTPUT JSON SCHEMA");
        userBuilder.AppendLine(
            """
            {
              "scenarios": [
                {
                  "scenarioId": "SCN-001",
                  "title": "string",
                  "priority": "High",
                  "suggestedLevel": "Api",
                  "sourceAcceptanceCriteriaRefs": ["AC-1"],
                  "riskRationale": "string",
                  "preconditions": ["string"],
                  "gherkin": "Scenario: ...",
                  "expectedOutcome": "string",
                  "duplicateAssessment": "string",
                  "existingXrayIssueKey": "RM-15905"
                }
              ]
            }
            """);

        return new LlmPromptRequest(systemPrompt, userBuilder.ToString().Trim(), null);
    }

    private GeneratedScenarioBundle ParseScenarioOutput(LlmCompletionResult completion)
    {
        try
        {
            var payload = JsonSerializer.Deserialize<ScenarioResponsePayload>(completion.JsonOutput, JsonSerializerOptions)
                          ?? throw new InvalidOperationException("Scenario generation returned an empty JSON document.");
            var scenarios = payload.Scenarios?
                .Select(scenario => new GeneratedScenario(
                    scenario.ScenarioId ?? string.Empty,
                    scenario.Title ?? string.Empty,
                    scenario.Priority ?? string.Empty,
                    scenario.SuggestedLevel ?? string.Empty,
                    scenario.SourceAcceptanceCriteriaRefs ?? Array.Empty<string>(),
                    scenario.RiskRationale ?? string.Empty,
                    scenario.Preconditions ?? Array.Empty<string>(),
                    scenario.Gherkin ?? string.Empty,
                    scenario.ExpectedOutcome ?? string.Empty,
                    scenario.DuplicateAssessment ?? string.Empty,
                    scenario.ExistingXrayIssueKey))
                .ToArray() ?? Array.Empty<GeneratedScenario>();

            return new GeneratedScenarioBundle(
                scenarios,
                completion.Provider,
                completion.Model,
                completion.JsonOutput)
            {
                Usage = completion.Usage,
                ProviderRequestCount = completion.ProviderRequestCount,
            };
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException("Scenario generation returned invalid JSON.", ex);
        }
    }

    private void Validate(GeneratedScenarioBundle bundle, GenerationContextBundle context)
    {
        if (bundle.Scenarios.Count < _options.MinScenarios)
        {
            throw new InvalidOperationException(
                $"Scenario generation returned fewer than the required minimum of {_options.MinScenarios} scenario(s).");
        }

        if (bundle.Scenarios.Count > _options.MaxScenarios)
        {
            throw new InvalidOperationException(
                $"Scenario generation returned more than the configured maximum of {_options.MaxScenarios} scenario(s).");
        }

        var duplicateIds = bundle.Scenarios
            .GroupBy(scenario => scenario.ScenarioId, StringComparer.OrdinalIgnoreCase)
            .Where(group => !string.IsNullOrWhiteSpace(group.Key) && group.Count() > 1)
            .Select(group => group.Key)
            .ToArray();
        if (duplicateIds.Length > 0)
        {
            throw new InvalidOperationException(
                $"Scenario generation returned duplicate scenario IDs: {string.Join(", ", duplicateIds)}");
        }

        var existingCoverage = ExtractExistingCoverage(context);
        foreach (var scenario in bundle.Scenarios)
        {
            ValidateScenario(scenario, context, existingCoverage);
        }
    }

    private static void ValidateScenario(
        GeneratedScenario scenario,
        GenerationContextBundle context,
        IReadOnlyDictionary<string, string> existingCoverage)
    {
        ValidateRequired(scenario.ScenarioId, "scenarioId");
        ValidateRequired(scenario.Title, "title");
        ValidateRequired(scenario.Priority, "priority");
        ValidateRequired(scenario.SuggestedLevel, "suggestedLevel");
        ValidateRequired(scenario.RiskRationale, "riskRationale");
        ValidateRequired(scenario.Gherkin, "gherkin");
        ValidateRequired(scenario.ExpectedOutcome, "expectedOutcome");
        ValidateRequired(scenario.DuplicateAssessment, "duplicateAssessment");

        ValidateExistingXrayIssueKey(scenario, context);
        ValidateAcceptanceCriteriaReferences(scenario, context);

        if (!scenario.SuggestedLevel.Equals(context.TestScope.ToString(), StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"Scenario '{scenario.ScenarioId}' suggested level '{scenario.SuggestedLevel}' does not match requested scope '{context.TestScope}'.");
        }

        ValidateDuplicateAssessment(scenario, existingCoverage);
    }

    private static void ValidateRequired(string value, string fieldName)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new InvalidOperationException($"Scenario field '{fieldName}' is required.");
        }
    }

    private static void ValidateExistingXrayIssueKey(
        GeneratedScenario scenario,
        GenerationContextBundle context)
    {
        if (string.IsNullOrWhiteSpace(scenario.ExistingXrayIssueKey))
        {
            return;
        }

        var issueProjectKey = ExtractIssueProjectKey(context.IssueKey);
        var expectedPattern = $"^{Regex.Escape(issueProjectKey)}-\\d+$";
        if (!Regex.IsMatch(scenario.ExistingXrayIssueKey, expectedPattern, RegexOptions.IgnoreCase))
        {
            throw new InvalidOperationException(
                $"Scenario '{scenario.ScenarioId}' returned an invalid existingXrayIssueKey '{scenario.ExistingXrayIssueKey}'. Expected a Jira/Xray key matching '{issueProjectKey}-<number>'.");
        }
    }

    private static void ValidateAcceptanceCriteriaReferences(
        GeneratedScenario scenario,
        GenerationContextBundle context)
    {
        var availableAcceptanceCriteriaRefs = AcceptanceCriteriaReferenceFormatter.ExtractAvailableReferences(context);
        if (availableAcceptanceCriteriaRefs.Count == 0)
        {
            if (scenario.SourceAcceptanceCriteriaRefs.Count > 0)
            {
                throw new InvalidOperationException(
                    $"Scenario '{scenario.ScenarioId}' returned sourceAcceptanceCriteriaRefs even though no ACCEPTANCE CRITERIA refs were provided in context.");
            }

            return;
        }

        if (scenario.SourceAcceptanceCriteriaRefs.Count == 0)
        {
            throw new InvalidOperationException(
                $"Scenario '{scenario.ScenarioId}' must include at least one sourceAcceptanceCriteriaRefs entry from the ACCEPTANCE CRITERIA section.");
        }

        var invalidReferences = scenario.SourceAcceptanceCriteriaRefs
            .Where(reference => !availableAcceptanceCriteriaRefs.Contains(reference))
            .ToArray();
        if (invalidReferences.Length > 0)
        {
            throw new InvalidOperationException(
                $"Scenario '{scenario.ScenarioId}' referenced unknown acceptance criteria refs: {string.Join(", ", invalidReferences)}.");
        }
    }

    private static void ValidateDuplicateAssessment(
        GeneratedScenario scenario,
        IReadOnlyDictionary<string, string> existingCoverage)
    {
        if (existingCoverage.Count == 0)
        {
            return;
        }

        var normalizedScenarioTitle = NormalizeForComparison(scenario.Title);
        var exactMatch = existingCoverage.FirstOrDefault(
            coverage => NormalizeForComparison(coverage.Value) == normalizedScenarioTitle);

        if (!string.IsNullOrWhiteSpace(exactMatch.Key))
        {
            if (string.IsNullOrWhiteSpace(scenario.ExistingXrayIssueKey))
            {
                throw new InvalidOperationException(
                    $"Scenario '{scenario.ScenarioId}' duplicates existing Xray test '{exactMatch.Key}' by exact title but did not set existingXrayIssueKey.");
            }

            if (!scenario.ExistingXrayIssueKey.Equals(exactMatch.Key, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    $"Scenario '{scenario.ScenarioId}' duplicates existing Xray test '{exactMatch.Key}' by exact title but returned existingXrayIssueKey '{scenario.ExistingXrayIssueKey}'.");
            }
        }

        if (!string.IsNullOrWhiteSpace(scenario.ExistingXrayIssueKey))
        {
            if (!existingCoverage.ContainsKey(scenario.ExistingXrayIssueKey))
            {
                throw new InvalidOperationException(
                    $"Scenario '{scenario.ScenarioId}' referenced existingXrayIssueKey '{scenario.ExistingXrayIssueKey}', but that key was not present in the existing coverage index.");
            }

            if (!scenario.DuplicateAssessment.Contains(scenario.ExistingXrayIssueKey, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    $"Scenario '{scenario.ScenarioId}' must reference existingXrayIssueKey '{scenario.ExistingXrayIssueKey}' in duplicateAssessment.");
            }

            return;
        }

        if (!scenario.DuplicateAssessment.Contains("net-new", StringComparison.OrdinalIgnoreCase) &&
            !scenario.DuplicateAssessment.Contains("no overlap", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"Scenario '{scenario.ScenarioId}' must explicitly state in duplicateAssessment that it is net-new or has no overlap with the existing coverage index.");
        }
    }

    private static IReadOnlyDictionary<string, string> ExtractExistingCoverage(GenerationContextBundle context)
    {
        var coverage = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var section in context.Sections.Where(section =>
                     section.Key is "existing_xray_coverage_index" or "existing_linked_xray_tests"))
        {
            foreach (var line in section.Content.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (!line.StartsWith("- ", StringComparison.Ordinal))
                {
                    continue;
                }

                var separatorIndex = line.IndexOf(':');
                if (separatorIndex <= 2)
                {
                    continue;
                }

                var issueKey = line[2..separatorIndex].Trim();
                var summary = line[(separatorIndex + 1)..].Trim();
                if (string.IsNullOrWhiteSpace(issueKey) || string.IsNullOrWhiteSpace(summary))
                {
                    continue;
                }

                coverage.TryAdd(issueKey, summary);
            }
        }

        return coverage;
    }

    private static string NormalizeForComparison(string value)
        => Regex.Replace(value.ToLowerInvariant(), "[^a-z0-9]+", " ").Trim();

    private static string ExtractIssueProjectKey(string issueKey)
    {
        var separatorIndex = issueKey.IndexOf('-');
        if (separatorIndex <= 0)
        {
            throw new InvalidOperationException(
                $"Issue key '{issueKey}' is invalid and cannot be used to validate existing Xray keys.");
        }

        return issueKey[..separatorIndex];
    }

    private sealed class ScenarioResponsePayload
    {
        public IReadOnlyList<ScenarioPayload>? Scenarios { get; init; }
    }

    private sealed class ScenarioPayload
    {
        public string? ScenarioId { get; init; }

        public string? Title { get; init; }

        public string? Priority { get; init; }

        public string? SuggestedLevel { get; init; }

        public IReadOnlyList<string>? SourceAcceptanceCriteriaRefs { get; init; }

        public string? RiskRationale { get; init; }

        public IReadOnlyList<string>? Preconditions { get; init; }

        public string? Gherkin { get; init; }

        public string? ExpectedOutcome { get; init; }

        public string? DuplicateAssessment { get; init; }

        public string? ExistingXrayIssueKey { get; init; }
    }
}
