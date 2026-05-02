using Manso.Domain;
using Microsoft.Extensions.Logging;
using System.Text.RegularExpressions;

namespace Manso.Application;

public sealed class OutputValidator : IOutputValidator
{
    private static readonly Regex GherkinHeaderRegex = new(
        @"^\s*(Feature:|Scenario:|Scenario Outline:|Given\s+|When\s+|Then\s+)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private readonly ILogger<OutputValidator> _logger;

    public OutputValidator(ILogger<OutputValidator> logger)
    {
        _logger = logger;
    }

    public Task<ValidationResult> ValidateAsync(
        GenerationContextBundle bundle,
        GeneratedScenarioBundle scenarios,
        CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var messages = new List<ValidationMessage>();
        ValidateScenarios(bundle, scenarios, messages);

        var outcome = DetermineOutcome(messages);
        _logger.LogInformation(
            "Validation completed with outcome {Outcome}. Errors: {ErrorCount}, Warnings: {WarningCount}.",
            outcome,
            messages.Count(message => message.Severity.Equals("Error", StringComparison.OrdinalIgnoreCase)),
            messages.Count(message => message.Severity.Equals("Warning", StringComparison.OrdinalIgnoreCase)));

        return Task.FromResult(new ValidationResult(outcome, messages));
    }

    private static void ValidateScenarios(
        GenerationContextBundle bundle,
        GeneratedScenarioBundle scenarios,
        ICollection<ValidationMessage> messages)
    {
        var availableAcceptanceCriteriaRefs = AcceptanceCriteriaReferenceFormatter.ExtractAvailableReferences(bundle);
        var duplicateTitles = scenarios.Scenarios
            .GroupBy(scenario => scenario.Title, StringComparer.OrdinalIgnoreCase)
            .Where(group => !string.IsNullOrWhiteSpace(group.Key) && group.Count() > 1)
            .Select(group => group.Key)
            .ToArray();

        foreach (var title in duplicateTitles)
        {
            messages.Add(new ValidationMessage(
                "duplicate_scenario_title",
                "Error",
                $"Scenario title '{title}' was generated more than once.",
                null));
        }

        foreach (var scenario in scenarios.Scenarios)
        {
            if (availableAcceptanceCriteriaRefs.Count == 0 && scenario.SourceAcceptanceCriteriaRefs.Count > 0)
            {
                messages.Add(new ValidationMessage(
                    "scenario_grounding_ref_unexpected",
                    "Error",
                    $"Scenario '{scenario.ScenarioId}' returned acceptance criteria refs even though none were available in context.",
                    null));
            }

            if (availableAcceptanceCriteriaRefs.Count > 0 && scenario.SourceAcceptanceCriteriaRefs.Count == 0)
            {
                messages.Add(new ValidationMessage(
                    "scenario_missing_grounding",
                    "Error",
                    $"Scenario '{scenario.ScenarioId}' is missing grounding references.",
                    null));
            }

            var invalidReferences = scenario.SourceAcceptanceCriteriaRefs
                .Where(reference => !availableAcceptanceCriteriaRefs.Contains(reference))
                .ToArray();
            if (invalidReferences.Length > 0)
            {
                messages.Add(new ValidationMessage(
                    "scenario_grounding_ref_invalid",
                    "Error",
                    $"Scenario '{scenario.ScenarioId}' referenced unknown acceptance criteria refs: {string.Join(", ", invalidReferences)}.",
                    null));
            }

            if (string.IsNullOrWhiteSpace(scenario.ExpectedOutcome))
            {
                messages.Add(new ValidationMessage(
                    "scenario_expected_outcome_missing",
                    "Error",
                    $"Scenario '{scenario.ScenarioId}' must include an expected outcome.",
                    null));
            }

            if (string.IsNullOrWhiteSpace(scenario.Gherkin) || !GherkinHeaderRegex.IsMatch(scenario.Gherkin))
            {
                messages.Add(new ValidationMessage(
                    "scenario_gherkin_invalid",
                    "Error",
                    $"Scenario '{scenario.ScenarioId}' must include a Gherkin-formatted behavior description.",
                    null));
            }
        }
    }

    private static ValidationOutcome DetermineOutcome(IReadOnlyCollection<ValidationMessage> messages)
    {
        if (messages.Any(message => message.Severity.Equals("Error", StringComparison.OrdinalIgnoreCase)))
        {
            return ValidationOutcome.Fail;
        }

        if (messages.Any(message => message.Severity.Equals("Warning", StringComparison.OrdinalIgnoreCase)))
        {
            return ValidationOutcome.PassWithWarnings;
        }

        return ValidationOutcome.Pass;
    }
}
