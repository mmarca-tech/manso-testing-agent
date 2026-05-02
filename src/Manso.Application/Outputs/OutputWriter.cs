using Manso.Domain;
using System.Text;
using System.Text.Json;

namespace Manso.Application;

public sealed class OutputWriter : IOutputWriter
{
    public Task<OutputWriteResult> WriteAsync(
        GenerationContextBundle bundle,
        GeneratedScenarioBundle scenarios,
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
            $"run://{bundle.IssueKey}/generated-scenarios.md",
            scenarioMarkdown));

        var writeResult = new WriteResult(
            validation.Outcome == ValidationOutcome.Fail
                ? "ValidationFailedArtifactsOnly"
                : "ScenarioArtifactsStored",
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
            $"run://{bundle.IssueKey}/write-result.json",
            JsonSerializer.Serialize(writeResult)));

        return Task.FromResult(new OutputWriteResult(writeResult, artifacts));
    }

    private static string RenderScenarioMarkdown(
        GenerationContextBundle bundle,
        GeneratedScenarioBundle scenarios,
        ValidationResult validation)
    {
        var builder = new StringBuilder();
        builder.AppendLine($"# Scenario Output for {bundle.IssueKey}");
        builder.AppendLine();
        builder.AppendLine($"- Workflow pass: {bundle.WorkflowPass}");
        builder.AppendLine($"- Test scope: {bundle.TestScope}");
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
