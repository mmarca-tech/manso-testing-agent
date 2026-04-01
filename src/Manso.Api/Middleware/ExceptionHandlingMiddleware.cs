using System.Net;
using Manso.Application;

namespace Manso.Api;

public sealed class ExceptionHandlingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<ExceptionHandlingMiddleware> _logger;

    public ExceptionHandlingMiddleware(
        RequestDelegate next,
        ILogger<ExceptionHandlingMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await _next(context);
        }
        catch (RequestValidationException ex)
        {
            await context.WriteApiErrorAsync(HttpStatusCode.BadRequest, new ApiErrorResponse(
                "INVALID_REQUEST",
                ex.Message,
                new
                {
                    field = ex.Field,
                    value = ex.Value,
                }));
        }
        catch (KeyNotFoundException ex)
        {
            await context.WriteApiErrorAsync(HttpStatusCode.NotFound, new ApiErrorResponse(
                "RUN_NOT_FOUND",
                ex.Message));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Unhandled exception while processing request.");
            await context.WriteApiErrorAsync(HttpStatusCode.InternalServerError, new ApiErrorResponse(
                "INTERNAL_ERROR",
                "An internal error occurred."));
        }
    }
}
