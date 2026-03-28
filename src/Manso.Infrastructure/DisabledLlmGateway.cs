using Manso.Application;

namespace Manso.Infrastructure;

public sealed class DisabledLlmGateway : ILlmGateway
{
    public Task<LlmCompletionResult> CompleteJsonAsync(
        LlmPromptRequest request,
        CancellationToken ct)
        => throw new InvalidOperationException(
            "LLM provider is disabled. Configure Llm:Provider as OpenAi, Anthropic, or Mock.");
}
