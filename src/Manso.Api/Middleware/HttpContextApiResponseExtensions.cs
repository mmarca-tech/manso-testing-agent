using System.Net;

namespace Manso.Api;

public static class HttpContextApiResponseExtensions
{
    public static Task WriteApiErrorAsync(
        this HttpContext context,
        HttpStatusCode statusCode,
        ApiErrorResponse response)
    {
        context.Response.StatusCode = (int)statusCode;
        return context.Response.WriteAsJsonAsync(response);
    }
}
