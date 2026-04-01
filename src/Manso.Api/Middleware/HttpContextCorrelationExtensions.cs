namespace Manso.Api;

public static class HttpContextCorrelationExtensions
{
    public static string GetCorrelationId(this HttpContext httpContext)
        => httpContext.Items.TryGetValue(CorrelationIdMiddleware.CorrelationIdItemKey, out var value)
            ? Convert.ToString(value) ?? string.Empty
            : string.Empty;
}
