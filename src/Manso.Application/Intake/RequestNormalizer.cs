using Manso.Domain;

namespace Manso.Application;

public sealed class RequestNormalizer : IRequestNormalizer
{
    private readonly RequestNormalizationOptions _options;

    public RequestNormalizer(RequestNormalizationOptions options)
    {
        _options = options;
    }

    public Task<NormalizedRunRequest> NormalizeAsync(RawRunRequest request, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var workflowPass = ParseEnum<WorkflowPass>(
            request.WorkflowPass,
            "workflowPass");

        var normalizedRequest = new NormalizedRunRequest(
            request.IssueKey!.Trim(),
            workflowPass,
            _options.DefaultTestScope,
            null,
            request.RequestedBy!.Trim());

        return Task.FromResult(normalizedRequest);
    }

    private static TEnum ParseEnum<TEnum>(string? input, string fieldName)
        where TEnum : struct, Enum
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            throw new RequestValidationException(
                $"{fieldName} is required.",
                fieldName);
        }

        if (Enum.TryParse<TEnum>(input, ignoreCase: true, out var parsed) &&
            Enum.IsDefined(parsed))
        {
            return parsed;
        }

        throw new RequestValidationException(
            $"{fieldName} value is not supported.",
            fieldName,
            input);
    }
}
