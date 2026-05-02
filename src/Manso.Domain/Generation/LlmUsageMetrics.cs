namespace Manso.Domain;

public sealed record LlmUsageMetrics(
    int? InputTokens,
    int? OutputTokens,
    int? TotalTokens,
    int? ReasoningTokens);
