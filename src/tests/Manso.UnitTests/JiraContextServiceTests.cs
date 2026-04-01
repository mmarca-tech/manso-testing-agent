using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging.Abstractions;

namespace Manso.UnitTests;

public sealed class JiraContextServiceTests
{
    [Fact]
    public async Task BuildAsync_ReturnsIssueContext_WhenJiraReturnsRequiredFields()
    {
        var client = new StubJiraApiClient(new Dictionary<string, JiraIssueContext>(StringComparer.OrdinalIgnoreCase)
        {
            ["QA-1234"] = new(
                "QA-1234",
                "Retry callback",
                "Description text",
                null,
                "Story",
                "High",
                [new JiraCommentContext("1", "Alice", "Looks good", DateTimeOffset.UtcNow)],
                Array.Empty<JiraLinkedIssue>(),
                ["QA-1111"],
                ["payments"],
                Array.Empty<JiraDevelopmentRepository>()),
        });
        var service = new JiraContextService(
            client,
            new JiraRetrievalOptions { IncludeComments = true, MaxComments = 3 },
            NullLogger<JiraContextService>.Instance);

        var result = await service.BuildAsync(CreateRequest(), CancellationToken.None);

        Assert.Equal("QA-1234", result.IssueKey);
        Assert.Single(result.Comments);
        Assert.Contains("QA-1111", result.LinkedIssueKeys);
    }

    [Fact]
    public async Task BuildAsync_LoadsDescriptionReferencedIssueDescriptions_AsSupportingContext()
    {
        var client = new StubJiraApiClient(new Dictionary<string, JiraIssueContext>(StringComparer.OrdinalIgnoreCase)
        {
            ["QA-1234"] = new(
                "QA-1234",
                "Retry callback",
                "Follow the implementation from QA-5678 before enabling retries.",
                null,
                "Story",
                "High",
                Array.Empty<JiraCommentContext>(),
                Array.Empty<JiraLinkedIssue>(),
                Array.Empty<string>(),
                ["payments"],
                Array.Empty<JiraDevelopmentRepository>()),
            ["QA-5678"] = new(
                "QA-5678",
                "Original callback rollout",
                "The original rollout stores the callback status before retry evaluation.",
                null,
                "Story",
                "Medium",
                Array.Empty<JiraCommentContext>(),
                Array.Empty<JiraLinkedIssue>(),
                Array.Empty<string>(),
                ["payments"],
                Array.Empty<JiraDevelopmentRepository>()),
        });
        var service = new JiraContextService(
            client,
            new JiraRetrievalOptions(),
            NullLogger<JiraContextService>.Instance);

        var result = await service.BuildAsync(CreateRequest(), CancellationToken.None);

        var referencedIssue = Assert.Single(result.DescriptionReferencedIssues);
        Assert.Equal("QA-5678", referencedIssue.IssueKey);
        Assert.Contains("stores the callback status", referencedIssue.Description);
    }

    [Fact]
    public async Task BuildAsync_Throws_WhenSummaryAndNarrativeAreMissing()
    {
        var client = new StubJiraApiClient(new Dictionary<string, JiraIssueContext>(StringComparer.OrdinalIgnoreCase)
        {
            ["QA-1234"] = new(
                "QA-1234",
                "",
                "",
                null,
                "Story",
                null,
                Array.Empty<JiraCommentContext>(),
                Array.Empty<JiraLinkedIssue>(),
                Array.Empty<string>(),
                Array.Empty<string>(),
                Array.Empty<JiraDevelopmentRepository>()),
        });
        var service = new JiraContextService(
            client,
            new JiraRetrievalOptions(),
            NullLogger<JiraContextService>.Instance);

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.BuildAsync(CreateRequest(), CancellationToken.None));
    }

    private static NormalizedRunRequest CreateRequest()
        => new(
            "QA-1234",
            GenerationMode.TestCasesOnly,
            WorkflowPass.ScenarioDesign,
            TestScope.Api,
            "bank-otp-api",
            Array.Empty<string>(),
            CoverageIntent.Regression,
            OutputTarget.JiraComment,
            new RequestedBy("abc", "Manuel", "manuel@example.com"),
            DocumentationMode.ExplicitOnly);

    private sealed class StubJiraApiClient : IJiraApiClient
    {
        private readonly IReadOnlyDictionary<string, JiraIssueContext> _issues;

        public StubJiraApiClient(IReadOnlyDictionary<string, JiraIssueContext> issues)
        {
            _issues = issues;
        }

        public Task<JiraIssueContext> GetIssueContextAsync(
            string issueKey,
            bool includeComments,
            int maxComments,
            CancellationToken ct)
            => _issues.TryGetValue(issueKey, out var issue)
                ? Task.FromResult(issue)
                : throw new InvalidOperationException($"Issue '{issueKey}' was not configured for this test.");

        public Task EnsureTestCoverageLinkAsync(
            string requirementIssueKey,
            string testIssueKey,
            CancellationToken ct)
            => throw new NotSupportedException();
    }
}
