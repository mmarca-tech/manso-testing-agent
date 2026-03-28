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
            null,
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
            null,
            CancellationToken.None);

        Assert.Equal(ValidationOutcome.Fail, result.Outcome);
        Assert.Contains(result.Messages, message => message.Code == "scenario_gherkin_invalid");
    }

    [Fact]
    public async Task ValidateAsync_Fails_WhenGeneratedFileViolatesAdapterRules()
    {
        var validator = CreateValidator();

        var result = await validator.ValidateAsync(
            CreateBundle(),
            CreateScenarioBundle(),
            new GeneratedCodeBundle(
                [
                    new GeneratedFile(
                        "/src/Payments/RetryHandler.cs",
                        "public class RetryHandler { } // TODO",
                        GeneratedFileAction.Update),
                ],
                "Coverage",
                "{}"),
            CancellationToken.None);

        Assert.Equal(ValidationOutcome.Fail, result.Outcome);
        Assert.Contains(result.Messages, message => message.Code == "generated_file_path_protected");
        Assert.Contains(result.Messages, message => message.Code == "generated_file_path_not_allowed");
        Assert.Contains(result.Messages, message => message.Code == "generated_file_placeholder_detected");
    }

    [Fact]
    public async Task ValidateAsync_Fails_WhenGeneratedTestLacksAssertion()
    {
        var validator = CreateValidator();

        var result = await validator.ValidateAsync(
            CreateBundle(),
            CreateScenarioBundle(),
            new GeneratedCodeBundle(
                [
                    new GeneratedFile(
                        "/tests/Callbacks/RetryHandlerTests.cs",
                        """
                        public sealed class RetryHandlerTests
                        {
                            [Fact]
                            public void Retries_transient_failures()
                            {
                            }
                        }
                        """,
                        GeneratedFileAction.Create),
                ],
                "Coverage",
                "{}"),
            CancellationToken.None);

        Assert.Equal(ValidationOutcome.Fail, result.Outcome);
        Assert.Contains(result.Messages, message => message.Code == "generated_test_missing_assertion");
    }

    private static OutputValidator CreateValidator()
        => new(
            new ValidationOptions(),
            NullLogger<OutputValidator>.Instance);

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
                new GenerationContextSection(
                    "repo_test_conventions",
                    "REPO TEST CONVENTIONS",
                    """
                    Adapter Alias: bank-otp-api
                    Supports Executable Generation: False
                    Test Framework: xUnit
                    Target Framework: .NET 10
                    Test File Suffix: Tests.cs
                    Test Directories: /tests, /src/Tests
                    Helper Directories: /tests/helpers
                    Protected Paths: /src, /infra, /docs
                    Build Commands: dotnet build src/Manso.sln
                    Test Commands: dotnet test src/Manso.sln
                    Formatter Commands: dotnet format src/Manso.sln --verify-no-changes
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
