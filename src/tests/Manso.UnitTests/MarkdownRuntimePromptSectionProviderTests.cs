using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging.Abstractions;

namespace Manso.UnitTests;

public sealed class MarkdownRuntimePromptSectionProviderTests : IDisposable
{
    private readonly string _tempRoot = Path.Combine(Path.GetTempPath(), $"runtime-prompt-tests-{Guid.NewGuid():N}");

    [Fact]
    public void BuildScenarioGenerationSection_CompilesControlledGuardrails_FromMarkdown()
    {
        var runtimeRoot = Path.Combine(_tempRoot, "agent-runtime");
        Directory.CreateDirectory(runtimeRoot);
        File.WriteAllText(
            Path.Combine(runtimeRoot, "agent-personality.md"),
            """
            ## Personality

            You are rigorous, skeptical, and exact. You do not guess when the evidence is incomplete.
            Every proposed test should be traceable to a requirement, behavior change, risk, or code-path clue visible in the supplied context.
            You believe that a test case without provenance is only an opinion.

            ## Core behaviors

            - Treat Jira issue details and repository diff context as the primary sources of truth.
            - Use Confluence only when it is explicitly linked and clearly relevant.
            - Refuse uncontrolled scope expansion. Do not invent hidden systems, flows, or requirements.
            - Separate facts, inferences, and assumptions.

            ## Expected output qualities

            - Test cases are specific, bounded, and actionable.
            - Preconditions are explicit.
            - Expected results are observable and verifiable.
            - Missing information is called out explicitly rather than patched over.
            - Scenarios avoid duplicating the same idea with minor wording changes.
            """);
        File.WriteAllText(
            Path.Combine(runtimeRoot, "executable-generation-guardrails.md"),
            """
            ## Runtime rules

            - Treat Jira development metadata as the only authoritative repository-context source for iteration 1.
            - Do not introduce manual branch or PR override as a competing runtime path.
            - Keep scenario artifacts Gherkin-first even if executable matching later uses scenario ID or title.

            ## Implementation stance

            - Do not silently widen file scope, repo scope, or retrieval scope.
            """);

        var provider = new MarkdownRuntimePromptSectionProvider(
            new RuntimePromptOptions { RootPath = runtimeRoot },
            NullLogger<MarkdownRuntimePromptSectionProvider>.Instance);

        var section = provider.BuildScenarioGenerationSection(CreateMetadata());

        Assert.Equal("runtime_guardrails", section.Key);
        Assert.Contains("Apply these runtime guardrails as operational policy", section.Content);
        Assert.Contains("You are rigorous, skeptical, and exact.", section.Content);
        Assert.Contains("Treat Jira issue details and repository diff context as the primary sources of truth.", section.Content);
        Assert.Contains("Scenarios avoid duplicating the same idea with minor wording changes.", section.Content);
        Assert.Contains("Treat Jira development metadata as the only authoritative repository-context source for iteration 1.", section.Content);
        Assert.Contains("Requested scope for this run: Api.", section.Content);
    }

    [Fact]
    public void BuildScenarioGenerationSection_UsesFallback_WhenMarkdownIsMissing()
    {
        Directory.CreateDirectory(_tempRoot);

        var provider = new MarkdownRuntimePromptSectionProvider(
            new RuntimePromptOptions { RootPath = _tempRoot },
            NullLogger<MarkdownRuntimePromptSectionProvider>.Instance);

        var section = provider.BuildScenarioGenerationSection(CreateMetadata());

        Assert.Contains("Be rigorous, skeptical, and exact.", section.Content);
        Assert.Contains("Do not introduce manual branch or PR override as a competing runtime path.", section.Content);
    }

    [Fact]
    public void BuildScenarioGenerationSection_DoesNotThrow_WhenRootPathIsEmpty()
    {
        var provider = new MarkdownRuntimePromptSectionProvider(
            new RuntimePromptOptions { RootPath = string.Empty },
            NullLogger<MarkdownRuntimePromptSectionProvider>.Instance);

        var section = provider.BuildScenarioGenerationSection(CreateMetadata());

        Assert.Equal("runtime_guardrails", section.Key);
        Assert.False(string.IsNullOrWhiteSpace(section.Content));
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempRoot))
        {
            Directory.Delete(_tempRoot, recursive: true);
        }
    }

    private static RunMetadataContext CreateMetadata()
        => new(
            "QA-1234",
            GenerationMode.TestCasesOnly,
            TestScope.Api,
            CoverageIntent.Regression,
            OutputTarget.JiraComment,
            "bank-otp-api",
            "https://example.test/pr/1",
            null);
}
