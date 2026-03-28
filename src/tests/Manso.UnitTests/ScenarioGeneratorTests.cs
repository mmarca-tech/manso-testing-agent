using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging.Abstractions;

namespace Manso.UnitTests;

public sealed class ScenarioGeneratorTests
{
    [Fact]
    public async Task GenerateAsync_ReturnsScenarioBundle_WhenGatewayReturnsValidJson()
    {
        var generator = new ScenarioGenerator(
            new StubLlmGateway(
                """
                {
                  "scenarios": [
                    {
                      "scenarioId": "SCN-001",
                      "title": "Retries transient callback failures",
                      "priority": "High",
                      "suggestedLevel": "Api",
                      "sourceAcceptanceCriteriaRefs": ["AC-1"],
                      "riskRationale": "Retry logic changed and failure handling is critical.",
                      "preconditions": ["A callback exists"],
                      "gherkin": "Scenario: Retry transient callback failure",
                      "expectedOutcome": "The callback is retried and succeeds.",
                      "duplicateAssessment": "No close duplicate found."
                    }
                  ]
                }
                """),
            new ScenarioGenerationOptions
            {
                MinScenarios = 1,
                MaxScenarios = 4,
            },
            NullLogger<ScenarioGenerator>.Instance);

        var result = await generator.GenerateAsync(CreateBundle(), CancellationToken.None);

        Assert.Single(result.Scenarios);
        Assert.Equal("Mock", result.ModelProvider);
        Assert.Equal("SCN-001", result.Scenarios[0].ScenarioId);
    }

    [Fact]
    public async Task GenerateAsync_Throws_WhenSuggestedLevelDoesNotMatchRequestedScope()
    {
        var generator = new ScenarioGenerator(
            new StubLlmGateway(
                """
                {
                  "scenarios": [
                    {
                      "scenarioId": "SCN-001",
                      "title": "Wrong level example",
                      "priority": "High",
                      "suggestedLevel": "Unit",
                      "sourceAcceptanceCriteriaRefs": ["AC-1"],
                      "riskRationale": "Mismatch test.",
                      "preconditions": ["A callback exists"],
                      "gherkin": "Scenario: Wrong level",
                      "expectedOutcome": "It fails validation.",
                      "duplicateAssessment": "No duplicate."
                    }
                  ]
                }
                """),
            new ScenarioGenerationOptions(),
            NullLogger<ScenarioGenerator>.Instance);

        await Assert.ThrowsAsync<InvalidOperationException>(() => generator.GenerateAsync(CreateBundle(), CancellationToken.None));
    }

    private static GenerationContextBundle CreateBundle()
        => new(
            new RunMetadataContext(
                "QA-1234",
                GenerationMode.TestCasesOnly,
                TestScope.Api,
                CoverageIntent.Regression,
                OutputTarget.JiraComment,
                "bank-otp-api",
                "https://dev.azure.com/afs-dev/rps/_git/bank-otp-api/pullrequest/882",
                null),
            [
                new GenerationContextSection("run_metadata", "RUN METADATA", "Requested scope: Api"),
                new GenerationContextSection("jira_issue", "JIRA ISSUE", "Summary: Retry callback"),
            ],
            Array.Empty<RunWarning>(),
            1,
            1,
            1,
            0);

    private sealed class StubLlmGateway : ILlmGateway
    {
        private readonly string _json;

        public StubLlmGateway(string json)
        {
            _json = json;
        }

        public Task<LlmCompletionResult> CompleteJsonAsync(
            LlmPromptRequest request,
            CancellationToken ct)
            => Task.FromResult(new LlmCompletionResult("Mock", "mock-model", _json));
    }
}
