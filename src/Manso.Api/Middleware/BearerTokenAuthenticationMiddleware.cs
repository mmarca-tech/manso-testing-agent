using Microsoft.Extensions.Options;
using System.Net;
using System.Security.Cryptography;
using System.Text;

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
            await context.WriteApiErrorAsync(
                HttpStatusCode.InternalServerError,
                new ApiErrorResponse(
                    "AUTH_CONFIGURATION_INVALID",
                    "Run intake authentication is not configured."));
            return;
        }

        var authorizationHeader = context.Request.Headers.Authorization.ToString();
        if (!authorizationHeader.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            await context.WriteApiErrorAsync(
                HttpStatusCode.Unauthorized,
                new ApiErrorResponse(
                    "UNAUTHORIZED",
                    "Request authentication failed."));
            return;
        }

        var providedToken = authorizationHeader["Bearer ".Length..].Trim();
        if (!TokensMatch(providedToken, configuredToken))
        {
            await context.WriteApiErrorAsync(
                HttpStatusCode.Unauthorized,
                new ApiErrorResponse(
                    "UNAUTHORIZED",
                    "Request authentication failed."));
            return;
        }

        await _next(context);
    }

    private static bool TokensMatch(string providedToken, string configuredToken)
    {
        var providedBytes = Encoding.UTF8.GetBytes(providedToken);
        var configuredBytes = Encoding.UTF8.GetBytes(configuredToken);
        return CryptographicOperations.FixedTimeEquals(providedBytes, configuredBytes);
    }
}
