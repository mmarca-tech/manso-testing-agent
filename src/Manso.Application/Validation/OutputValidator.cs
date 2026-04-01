using System.Text.RegularExpressions;
using Manso.Domain;
using Microsoft.Extensions.Logging;

namespace Manso.Application;

public sealed class OutputValidator : IOutputValidator
{
    private static readonly Regex GherkinHeaderRegex = new(
        @"^\s*(Feature:|Scenario:|Scenario Outline:|Given\s+|When\s+|Then\s+)",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private readonly ValidationOptions _options;
    private readonly ILogger<OutputValidator> _logger;

    public OutputValidator(
        ValidationOptions options,
        ILogger<OutputValidator> logger)
    {
        _options = options;
        _logger = logger;
    }

    public Task<ValidationResult> ValidateAsync(
        GenerationContextBundle bundle,
        GeneratedScenarioBundle scenarios,
        GeneratedCodeBundle? code,
        CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var messages = new List<ValidationMessage>();
        ValidateScenarios(bundle, scenarios, messages);

        if (code is not null)
        {
            ValidateGeneratedFiles(bundle, code, messages);
        }

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

    private void ValidateGeneratedFiles(
        GenerationContextBundle bundle,
        GeneratedCodeBundle code,
        ICollection<ValidationMessage> messages)
    {
        var conventionsSection = bundle.Sections.FirstOrDefault(section =>
            section.Key.Equals("repo_test_conventions", StringComparison.OrdinalIgnoreCase));

        var allowedTestRoots = ExtractConventionList(conventionsSection?.Content, "Test Directories:");
        var protectedRoots = ExtractConventionList(conventionsSection?.Content, "Protected Paths:");
        var helperRoots = ExtractConventionList(conventionsSection?.Content, "Helper Directories:");
        var allowedRoots = allowedTestRoots.Concat(helperRoots).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();

        foreach (var file in code.Files)
        {
            var normalizedPath = NormalizePath(file.Path);
            var extension = Path.GetExtension(normalizedPath);

            if (_options.AllowedFileExtensions.Length > 0 &&
                !_options.AllowedFileExtensions.Contains(extension, StringComparer.OrdinalIgnoreCase))
            {
                messages.Add(new ValidationMessage(
                    "generated_file_extension_not_allowed",
                    "Error",
                    $"Generated file '{normalizedPath}' uses unsupported extension '{extension}'.",
                    normalizedPath));
            }

            if (protectedRoots.Any(root => normalizedPath.StartsWith(root, StringComparison.OrdinalIgnoreCase)))
            {
                messages.Add(new ValidationMessage(
                    "generated_file_path_protected",
                    "Error",
                    $"Generated file '{normalizedPath}' targets a protected path.",
                    normalizedPath));
            }

            if (allowedRoots.Length > 0 &&
                !allowedRoots.Any(root => normalizedPath.StartsWith(root, StringComparison.OrdinalIgnoreCase)))
            {
                messages.Add(new ValidationMessage(
                    "generated_file_path_not_allowed",
                    "Error",
                    $"Generated file '{normalizedPath}' is outside adapter-approved directories.",
                    normalizedPath));
            }

            foreach (var marker in _options.PlaceholderMarkers)
            {
                if (!string.IsNullOrWhiteSpace(marker) &&
                    file.Content.Contains(marker, StringComparison.OrdinalIgnoreCase))
                {
                    messages.Add(new ValidationMessage(
                        "generated_file_placeholder_detected",
                        "Error",
                        $"Generated file '{normalizedPath}' contains placeholder marker '{marker}'.",
                        normalizedPath));
                }
            }

            if (_options.RequireAssertionsInGeneratedTests &&
                IsLikelyTestFile(normalizedPath) &&
                !ContainsAssertion(file.Content))
            {
                messages.Add(new ValidationMessage(
                    "generated_test_missing_assertion",
                    "Error",
                    $"Generated test file '{normalizedPath}' does not contain an obvious assertion.",
                    normalizedPath));
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

    private static string[] ExtractConventionList(string? content, string key)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return Array.Empty<string>();
        }

        var line = content.Split('\n')
            .Select(value => value.Trim())
            .FirstOrDefault(value => value.StartsWith(key, StringComparison.OrdinalIgnoreCase));
        if (string.IsNullOrWhiteSpace(line))
        {
            return Array.Empty<string>();
        }

        var value = line[key.Length..].Trim();
        if (value.Equals("Not specified", StringComparison.OrdinalIgnoreCase))
        {
            return Array.Empty<string>();
        }

        return value
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(NormalizePath)
            .ToArray();
    }

    private static string NormalizePath(string path)
    {
        var normalized = path.Replace('\\', '/').Trim();
        if (!normalized.StartsWith("/", StringComparison.Ordinal))
        {
            normalized = "/" + normalized;
        }

        return normalized;
    }

    private static bool IsLikelyTestFile(string path)
        => path.Contains("/test", StringComparison.OrdinalIgnoreCase) ||
           path.Contains("/tests", StringComparison.OrdinalIgnoreCase) ||
           path.EndsWith("Tests.cs", StringComparison.OrdinalIgnoreCase) ||
           path.Contains(".spec.", StringComparison.OrdinalIgnoreCase) ||
           path.Contains(".test.", StringComparison.OrdinalIgnoreCase);

    private static bool ContainsAssertion(string content)
        => content.Contains("Assert.", StringComparison.Ordinal) ||
           content.Contains("await Assert.", StringComparison.Ordinal) ||
           content.Contains(".Should(", StringComparison.Ordinal) ||
           content.Contains("Should().", StringComparison.Ordinal) ||
           content.Contains("expect(", StringComparison.Ordinal);
}
