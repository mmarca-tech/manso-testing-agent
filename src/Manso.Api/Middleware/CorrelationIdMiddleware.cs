namespace Manso.Api;

public sealed class CorrelationIdMiddleware
{
    public const string CorrelationIdItemKey = "CorrelationId";
    public const string CorrelationIdHeaderName = "X-Correlation-Id";

    private readonly RequestDelegate _next;
    private readonly ILogger<CorrelationIdMiddleware> _logger;

    public CorrelationIdMiddleware(RequestDelegate next, ILogger<CorrelationIdMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var correlationId = context.Request.Headers.TryGetValue(CorrelationIdHeaderName, out var existingHeader)
            && !string.IsNullOrWhiteSpace(existingHeader)
            ? existingHeader.ToString()
            : Guid.NewGuid().ToString("D");

        context.Items[CorrelationIdItemKey] = correlationId;
        context.Response.Headers[CorrelationIdHeaderName] = correlationId;

        using (_logger.BeginScope(new Dictionary<string, object?>
        {
            ["CorrelationId"] = correlationId,
        }))
        {
            await _next(context);
        }
    }
}
