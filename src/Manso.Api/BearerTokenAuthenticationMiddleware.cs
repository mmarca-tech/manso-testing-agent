using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Manso.Api;

public sealed class BearerTokenAuthenticationMiddleware
{
    private readonly RequestDelegate _next;
    private readonly IOptions<RunIntakeAuthenticationOptions> _options;

    public BearerTokenAuthenticationMiddleware(
        RequestDelegate next,
        IOptions<RunIntakeAuthenticationOptions> options)
    {
        _next = next;
        _options = options;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        if (!context.Request.Path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase))
        {
            await _next(context);
            return;
        }

        var configuredToken = _options.Value.BearerToken;
        if (string.IsNullOrWhiteSpace(configuredToken))
        {
            context.Response.StatusCode = (int)HttpStatusCode.InternalServerError;
            await context.Response.WriteAsJsonAsync(
                new ApiErrorResponse(
                    "AUTH_CONFIGURATION_INVALID",
                    "Run intake authentication is not configured."));
            return;
        }

        var authorizationHeader = context.Request.Headers.Authorization.ToString();
        if (!authorizationHeader.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            context.Response.StatusCode = (int)HttpStatusCode.Unauthorized;
            await context.Response.WriteAsJsonAsync(
                new ApiErrorResponse(
                    "UNAUTHORIZED",
                    "Request authentication failed."));
            return;
        }

        var providedToken = authorizationHeader["Bearer ".Length..].Trim();
        if (!string.Equals(providedToken, configuredToken, StringComparison.Ordinal))
        {
            context.Response.StatusCode = (int)HttpStatusCode.Unauthorized;
            await context.Response.WriteAsJsonAsync(
                new ApiErrorResponse(
                    "UNAUTHORIZED",
                    "Request authentication failed."));
            return;
        }

        await _next(context);
    }
}
