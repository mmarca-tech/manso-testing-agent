using System.Text;
using System.Text.Json;
using Manso.Domain;
using Microsoft.Extensions.Logging;

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
        var promptRequest = BuildPrompt(bundle);
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
                  "duplicateAssessment": "string"
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
                    scenario.DuplicateAssessment ?? string.Empty))
                .ToArray() ?? Array.Empty<GeneratedScenario>();

            return new GeneratedScenarioBundle(
                scenarios,
                completion.Provider,
                completion.Model,
                completion.JsonOutput);
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

        foreach (var scenario in bundle.Scenarios)
        {
            ValidateScenario(scenario, context);
        }
    }

    private static void ValidateScenario(GeneratedScenario scenario, GenerationContextBundle context)
    {
        ValidateRequired(scenario.ScenarioId, "scenarioId");
        ValidateRequired(scenario.Title, "title");
        ValidateRequired(scenario.Priority, "priority");
        ValidateRequired(scenario.SuggestedLevel, "suggestedLevel");
        ValidateRequired(scenario.RiskRationale, "riskRationale");
        ValidateRequired(scenario.Gherkin, "gherkin");
        ValidateRequired(scenario.ExpectedOutcome, "expectedOutcome");
        ValidateRequired(scenario.DuplicateAssessment, "duplicateAssessment");

        if (scenario.SourceAcceptanceCriteriaRefs.Count == 0)
        {
            throw new InvalidOperationException(
                $"Scenario '{scenario.ScenarioId}' must include at least one sourceAcceptanceCriteriaRefs entry.");
        }

        if (!scenario.SuggestedLevel.Equals(context.Metadata.TestScope.ToString(), StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"Scenario '{scenario.ScenarioId}' suggested level '{scenario.SuggestedLevel}' does not match requested scope '{context.Metadata.TestScope}'.");
        }
    }

    private static void ValidateRequired(string value, string fieldName)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new InvalidOperationException($"Scenario field '{fieldName}' is required.");
        }
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
    }
}
