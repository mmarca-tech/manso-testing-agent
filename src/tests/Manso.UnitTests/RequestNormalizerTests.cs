using Manso.Application;
using Manso.Domain;

namespace Manso.UnitTests;

public sealed class RequestNormalizerTests
{
    [Fact]
    public async Task NormalizeAsync_UsesRootWorkflowPassAndConfiguredDefaults()
    {
        var normalizer = new RequestNormalizer(new RequestNormalizationOptions
        {
            DefaultTestScope = TestScope.Api,
        });
        var request = CreateRequest();

        var result = await normalizer.NormalizeAsync(request, CancellationToken.None);

        Assert.Equal(WorkflowPass.ScenarioDesign, result.WorkflowPass);
        Assert.Equal(TestScope.Api, result.TestScope);
        Assert.Null(result.RepositoryAlias);
    }

    [Theory]
    [InlineData("DoEverything")]
    [InlineData("1")]
    public async Task NormalizeAsync_ThrowsForInvalidWorkflowPass(string workflowPass)
    {
        var normalizer = new RequestNormalizer(new RequestNormalizationOptions());
        var request = CreateRequest(workflowPass);

        var exception = await Assert.ThrowsAsync<RequestValidationException>(
            () => normalizer.NormalizeAsync(request, CancellationToken.None));

        Assert.Equal("workflowPass", exception.Field);
        Assert.Equal(workflowPass, exception.Value);
    }

    private static RawRunRequest CreateRequest(string? workflowPass = "ScenarioDesign")
        => new(
            workflowPass,
            "QA-1234",
            "abc-123");
}
