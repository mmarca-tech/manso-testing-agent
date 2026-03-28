namespace Manso.Api;

public sealed record ApiErrorResponse(
    string ErrorCode,
    string Message,
    object? Details = null);
