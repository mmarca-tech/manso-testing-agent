using Manso.Application;
using System.Text.Json;

namespace Manso.Infrastructure;

public sealed class MockLlmGateway : ILlmGateway
{
    public Task<LlmCompletionResult> CompleteJsonAsync(
        LlmPromptRequest request,
        CancellationToken ct)
    {
        var payload = new
        {
            scenarios = new[]
            {
                new
                {
                    scenarioId = "SCN-001",
                    title = "Retries transient callback failures",
                    priority = "High",
                    suggestedLevel = ExtractRequestedScope(request.UserPrompt),
                    sourceAcceptanceCriteriaRefs = new[] { "AC-1" },
                    riskRationale = "Changed retry handling is business critical and failure recovery must remain safe.",
                    preconditions = new[]
                    {
                        "A valid callback payload exists.",
                        "The downstream dependency returns a transient error on the first attempt.",
                    },
                    gherkin =
                        """
                        Scenario: Retry transient callback failure
                          Given a valid callback request
                          And the downstream dependency returns HTTP 503 on the first attempt
                          When the callback is processed
                          Then the callback is retried according to the retry policy
                          And the operation completes without duplicate side effects
                        """,
                    expectedOutcome = "The callback is retried and eventually succeeds without duplicate side effects.",
                    duplicateAssessment = "Already covered by QA-1001.",
                    existingXrayIssueKey = "QA-1001",
                },
                new
                {
                    scenarioId = "SCN-002",
                    title = "Does not retry terminal callback failures",
                    priority = "Medium",
                    suggestedLevel = ExtractRequestedScope(request.UserPrompt),
                    sourceAcceptanceCriteriaRefs = new[] { "AC-2" },
                    riskRationale = "Terminal failures must not trigger unnecessary retries or duplicate actions.",
                    preconditions = new[]
                    {
                        "A valid callback payload exists.",
                        "The downstream dependency returns a terminal validation failure.",
                    },
                    gherkin =
                        """
                        Scenario: Do not retry terminal callback failure
                          Given a valid callback request
                          And the downstream dependency returns a terminal validation failure
                          When the callback is processed
                          Then the callback is not retried
                          And the failure is surfaced deterministically
                        """,
                    expectedOutcome = "Terminal failures are surfaced without retrying the callback.",
                    duplicateAssessment = "Already covered by QA-1002.",
                    existingXrayIssueKey = "QA-1002",
                },
            },
        };

        return Task.FromResult(new LlmCompletionResult(
            "Mock",
            "mock-scenarios-v1",
            JsonSerializer.Serialize(payload)));
    }

    private static string ExtractRequestedScope(string prompt)
    {
        const string marker = "Requested scope: ";
        var index = prompt.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        if (index < 0)
        {
            return "Api";
        }

        var start = index + marker.Length;
        var end = prompt.IndexOfAny(['\r', '\n'], start);
        return end < 0
            ? prompt[start..].Trim()
            : prompt[start..end].Trim();
    }
}
