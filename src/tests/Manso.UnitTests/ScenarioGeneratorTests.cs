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
                      "duplicateAssessment": "Net-new after comparison against the existing coverage index; no overlap found.",
                      "existingXrayIssueKey": null
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
        Assert.Null(result.Scenarios[0].ExistingXrayIssueKey);
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
                      "duplicateAssessment": "Net-new after comparison against the existing coverage index; no overlap found.",
                      "existingXrayIssueKey": null
                    }
                  ]
                }
                """),
            new ScenarioGenerationOptions(),
            NullLogger<ScenarioGenerator>.Instance);

        await Assert.ThrowsAsync<InvalidOperationException>(() => generator.GenerateAsync(CreateBundle(), CancellationToken.None));
    }

    [Fact]
    public async Task GenerateAsync_AllowsExplicitExistingXrayIssueKey()
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
                      "duplicateAssessment": "Already covered by QA-1001.",
                      "existingXrayIssueKey": "QA-1001"
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

        Assert.Equal("QA-1001", Assert.Single(result.Scenarios).ExistingXrayIssueKey);
    }

    [Fact]
    public async Task GenerateAsync_PassesLinkedXrayTitlesSectionToLlm()
    {
        var gateway = new CapturingLlmGateway(
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
                  "duplicateAssessment": "Already covered by QA-1001 Retry transient callback failure.",
                  "existingXrayIssueKey": "QA-1001"
                }
              ]
            }
            """);
        var generator = new ScenarioGenerator(
            gateway,
            new ScenarioGenerationOptions
            {
                MinScenarios = 1,
                MaxScenarios = 4,
            },
            NullLogger<ScenarioGenerator>.Instance);

        await generator.GenerateAsync(CreateBundle(), CancellationToken.None);

        Assert.NotNull(gateway.LastRequest);
        Assert.Contains("EXISTING LINKED XRAY TESTS", gateway.LastRequest!.UserPrompt);
        Assert.Contains("AC-1: Retries must be idempotent.", gateway.LastRequest.UserPrompt);
        Assert.Contains("EXISTING XRAY COVERAGE INDEX", gateway.LastRequest.UserPrompt);
        Assert.Contains("QA-1001: Retry transient callback failure", gateway.LastRequest.UserPrompt);
        Assert.Contains("strongest duplicate signal", gateway.LastRequest.SystemPrompt);
        Assert.Contains("RUNTIME GUARDRAILS", gateway.LastRequest.UserPrompt);
        Assert.Contains("Follow the RUNTIME GUARDRAILS section", gateway.LastRequest.SystemPrompt);
        Assert.Contains("duplicateAssessment must explicitly state whether the scenario reuses an indexed Xray test", gateway.LastRequest.SystemPrompt);
        Assert.Contains("same project as the tested issue", gateway.LastRequest.SystemPrompt);
        Assert.Contains("sourceAcceptanceCriteriaRefs must cite one or more exact AC-* references", gateway.LastRequest.SystemPrompt);
    }

    [Fact]
    public async Task GenerateAsync_Throws_WhenScenarioDuplicatesExistingCoverageTitleWithoutExistingKey()
    {
        var generator = new ScenarioGenerator(
            new StubLlmGateway(
                """
                {
                  "scenarios": [
                    {
                      "scenarioId": "SCN-001",
                      "title": "Retry transient callback failure",
                      "priority": "High",
                      "suggestedLevel": "Api",
                      "sourceAcceptanceCriteriaRefs": ["AC-1"],
                      "riskRationale": "Retry logic changed and failure handling is critical.",
                      "preconditions": ["A callback exists"],
                      "gherkin": "Scenario: Retry transient callback failure",
                      "expectedOutcome": "The callback is retried and succeeds.",
                      "duplicateAssessment": "Net-new after comparison against the existing coverage index; no overlap found.",
                      "existingXrayIssueKey": null
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

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() => generator.GenerateAsync(CreateBundle(), CancellationToken.None));

        Assert.Contains("duplicates existing Xray test 'QA-1001'", exception.Message);
    }

    [Fact]
    public async Task GenerateAsync_Throws_WhenExistingXrayIssueKeyDoesNotMatchIssueProjectKey()
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
                      "duplicateAssessment": "Already covered by NRE01.",
                      "existingXrayIssueKey": "NRE01"
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

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() => generator.GenerateAsync(CreateBundle(), CancellationToken.None));

        Assert.Contains("Expected a Jira/Xray key matching 'QA-<number>'", exception.Message);
    }

    [Fact]
    public async Task GenerateAsync_Throws_WhenScenarioUsesUnknownAcceptanceCriteriaReference()
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
                      "sourceAcceptanceCriteriaRefs": ["AC-3"],
                      "riskRationale": "Retry logic changed and failure handling is critical.",
                      "preconditions": ["A callback exists"],
                      "gherkin": "Scenario: Retry transient callback failure",
                      "expectedOutcome": "The callback is retried and succeeds.",
                      "duplicateAssessment": "Net-new after comparison against the existing coverage index; no overlap found.",
                      "existingXrayIssueKey": null
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

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() => generator.GenerateAsync(CreateBundle(), CancellationToken.None));

        Assert.Contains("unknown acceptance criteria refs: AC-3", exception.Message);
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
                new GenerationContextSection(
                    "acceptance_criteria",
                    "ACCEPTANCE CRITERIA",
                    """
                    AC-1: Retries must be idempotent.
                    AC-2: Duplicate callbacks must be ignored.
                    """),
                new GenerationContextSection(
                    "existing_xray_coverage_index",
                    "EXISTING XRAY COVERAGE INDEX",
                    """
                    Review every candidate scenario against this index before proposing net-new coverage.
                    - QA-1001: Retry transient callback failure
                    """),
                new GenerationContextSection("existing_linked_xray_tests", "EXISTING LINKED XRAY TESTS", "- QA-1001: Retry transient callback failure"),
                new GenerationContextSection("runtime_guardrails", "RUNTIME GUARDRAILS", "- Be rigorous, skeptical, and exact."),
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

    private sealed class CapturingLlmGateway : ILlmGateway
    {
        private readonly string _json;

        public CapturingLlmGateway(string json)
        {
            _json = json;
        }

        public LlmPromptRequest? LastRequest { get; private set; }

        public Task<LlmCompletionResult> CompleteJsonAsync(
            LlmPromptRequest request,
            CancellationToken ct)
        {
            LastRequest = request;
            return Task.FromResult(new LlmCompletionResult("Mock", "mock-model", _json));
        }
    }
}
