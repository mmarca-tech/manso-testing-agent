using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging.Abstractions;

namespace Manso.UnitTests;

public sealed class OutputValidatorTests
{
    [Fact]
    public async Task ValidateAsync_ReturnsPass_ForValidScenarioOnlyOutput()
    {
        var validator = CreateValidator();

        var result = await validator.ValidateAsync(
            CreateBundle(),
            CreateScenarioBundle(),
            CancellationToken.None);

        Assert.Equal(ValidationOutcome.Pass, result.Outcome);
        Assert.Empty(result.Messages);
    }

    [Fact]
    public async Task ValidateAsync_Fails_WhenScenarioGherkinIsInvalid()
    {
        var validator = CreateValidator();

        var result = await validator.ValidateAsync(
            CreateBundle(),
            new GeneratedScenarioBundle(
                [
                    new GeneratedScenario(
                        "SCN-001",
                        "Retry transient failure",
                        "High",
                        "Api",
                        ["AC-1"],
                        "Critical retry path changed.",
                        ["Callback exists"],
                        "Retries callback",
                        "Callback is retried",
                        "No duplicate found"),
                ],
                "Mock",
                "mock-model",
                "{}"),
            CancellationToken.None);

        Assert.Equal(ValidationOutcome.Fail, result.Outcome);
        Assert.Contains(result.Messages, message => message.Code == "scenario_gherkin_invalid");
    }

    [Fact]
    public async Task ValidateAsync_Fails_WhenScenarioUsesUnknownAcceptanceCriteriaReference()
    {
        var validator = CreateValidator();

        var result = await validator.ValidateAsync(
            CreateBundle(),
            new GeneratedScenarioBundle(
                [
                    new GeneratedScenario(
                        "SCN-001",
                        "Retry transient failure",
                        "High",
                        "Api",
                        ["AC-99"],
                        "Critical retry path changed.",
                        ["Callback exists"],
                        "Scenario: Retry transient callback failure",
                        "Callback is retried",
                        "No duplicate found"),
                ],
                "Mock",
                "mock-model",
                "{}"),
            CancellationToken.None);

        Assert.Equal(ValidationOutcome.Fail, result.Outcome);
        Assert.Contains(result.Messages, message => message.Code == "scenario_grounding_ref_invalid");
    }

    [Fact]
    public async Task ValidateAsync_Fails_WhenScenarioTitleIsDuplicated()
    {
        var validator = CreateValidator();
        var scenario = new GeneratedScenario(
            "SCN-001",
            "Retry transient failure",
            "High",
            "Api",
            ["AC-1"],
            "Critical retry path changed.",
            ["Callback exists"],
            "Scenario: Retry transient callback failure",
            "Callback is retried",
            "No duplicate found");

        var result = await validator.ValidateAsync(
            CreateBundle(),
            new GeneratedScenarioBundle(
                [scenario, scenario with { ScenarioId = "SCN-002" }],
                "Mock",
                "mock-model",
                "{}"),
            CancellationToken.None);

        Assert.Equal(ValidationOutcome.Fail, result.Outcome);
        Assert.Contains(result.Messages, message => message.Code == "duplicate_scenario_title");
    }

    private static OutputValidator CreateValidator()
        => new(NullLogger<OutputValidator>.Instance);

    private static GenerationContextBundle CreateBundle()
        => new(
            "QA-1234",
            TestScope.Api,
            WorkflowPass.ScenarioDesign,
            [
                new GenerationContextSection(
                    "acceptance_criteria",
                    "ACCEPTANCE CRITERIA",
                    """
                    AC-1: Retries must be idempotent.
                    AC-2: Duplicate callbacks must be ignored.
                    """),
            ],
            Array.Empty<RunWarning>(),
            0,
            0,
            0,
            0);

    private static GeneratedScenarioBundle CreateScenarioBundle()
        => new(
            [
                new GeneratedScenario(
                    "SCN-001",
                    "Retry transient failure",
                    "High",
                    "Api",
                    ["AC-1"],
                    "Critical retry path changed.",
                    ["Callback exists"],
                    "Scenario: Retry transient callback failure",
                    "Callback is retried",
                    "No duplicate found"),
            ],
            "Mock",
            "mock-model",
            "{}");
}
