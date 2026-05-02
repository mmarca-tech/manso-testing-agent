using Manso.Application;
using Manso.Domain;
using System.Text.Json;

namespace Manso.UnitTests;

public sealed class OutputWriterTests
{
    [Fact]
    public async Task WriteAsync_CreatesScenarioMarkdownAndWriteResultArtifacts()
    {
        var writer = new OutputWriter();

        var result = await writer.WriteAsync(
            CreateBundle(),
            CreateScenarios(),
            new ValidationResult(ValidationOutcome.Pass, Array.Empty<ValidationMessage>()),
            CancellationToken.None);

        Assert.Contains(result.Artifacts, artifact => artifact.Type == "ScenarioMarkdown");
        Assert.Contains(result.Artifacts, artifact => artifact.Type == "WriteResultJson");

        var markdown = result.Artifacts.Single(artifact => artifact.Type == "ScenarioMarkdown");
        Assert.Contains("Scenario: Retry transient callback failure", markdown.Content);

        var writeResult = JsonSerializer.Deserialize<WriteResult>(
            result.Artifacts.Single(artifact => artifact.Type == "WriteResultJson").Content,
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.NotNull(writeResult);
        Assert.Equal("ScenarioArtifactsStored", writeResult.Status);
    }

    [Fact]
    public async Task WriteAsync_StoresArtifactsOnly_WhenValidationFails()
    {
        var writer = new OutputWriter();

        var result = await writer.WriteAsync(
            CreateBundle(),
            CreateScenarios(),
            new ValidationResult(
                ValidationOutcome.Fail,
                [
                    new ValidationMessage(
                        "scenario_gherkin_invalid",
                        "Error",
                        "Scenario must include Gherkin.",
                        null),
                ]),
            CancellationToken.None);

        Assert.Equal("ValidationFailedArtifactsOnly", result.Result.Status);
        Assert.Contains(result.Artifacts, artifact => artifact.Type == "ScenarioMarkdown");
        Assert.Contains(result.Artifacts, artifact => artifact.Type == "WriteResultJson");
    }

    private static GenerationContextBundle CreateBundle()
        => new(
            "QA-1234",
            TestScope.Api,
            WorkflowPass.ScenarioDesign,
            Array.Empty<GenerationContextSection>(),
            Array.Empty<RunWarning>(),
            0,
            0,
            0,
            0);

    private static GeneratedScenarioBundle CreateScenarios()
        => new(
            [
                new GeneratedScenario(
                    "SCN-001",
                    "Retry transient callback",
                    "High",
                    "Api",
                    ["AC-1"],
                    "Retry behavior changed.",
                    ["Callback exists"],
                    "Scenario: Retry transient callback failure",
                    "Callback is retried successfully",
                    "No duplicate found"),
            ],
            "Mock",
            "mock-model",
            "{}");
}
