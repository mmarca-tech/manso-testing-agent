using Manso.Application;
using Manso.Domain;
using Microsoft.Extensions.Logging.Abstractions;

namespace Manso.UnitTests;

public sealed class JiraContextServiceTests
{
    [Fact]
    public async Task BuildAsync_ReturnsIssueContext_WhenJiraReturnsRequiredFields()
    {
        var client = new StubJiraApiClient(new JiraIssueContext(
            "QA-1234",
            "Retry callback",
            "Description text",
            null,
            "Story",
            "High",
            [new JiraCommentContext("1", "Alice", "Looks good", DateTimeOffset.UtcNow)],
            ["QA-1111"],
            ["payments"],
            Array.Empty<JiraDevelopmentRepository>()));
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
    public async Task BuildAsync_Throws_WhenSummaryAndNarrativeAreMissing()
    {
        var client = new StubJiraApiClient(new JiraIssueContext(
            "QA-1234",
            "",
            "",
            null,
            "Story",
            null,
            Array.Empty<JiraCommentContext>(),
            Array.Empty<string>(),
            Array.Empty<string>(),
            Array.Empty<JiraDevelopmentRepository>()));
        var service = new JiraContextService(
            client,
            new JiraRetrievalOptions(),
            NullLogger<JiraContextService>.Instance);

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.BuildAsync(CreateRequest(), CancellationToken.None));
    }

    private static NormalizedRunRequest CreateRequest()
        => new(
            "QA-1234",
            "https://yourcompany.atlassian.net/browse/QA-1234",
            GenerationMode.TestCasesOnly,
            WorkflowPass.ScenarioDesign,
            TestScope.Api,
            "bank-otp-api",
            null,
            Array.Empty<string>(),
            CoverageIntent.Regression,
            OutputTarget.JiraComment,
            new RequestedBy("abc", "Manuel", "manuel@example.com"),
            DocumentationMode.ExplicitOnly);

    private sealed class StubJiraApiClient : IJiraApiClient
    {
        private readonly JiraIssueContext _issue;

        public StubJiraApiClient(JiraIssueContext issue)
        {
            _issue = issue;
        }

        public Task<JiraIssueContext> GetIssueContextAsync(
            string issueKey,
            bool includeComments,
            int maxComments,
            CancellationToken ct)
            => Task.FromResult(_issue);
    }
}
