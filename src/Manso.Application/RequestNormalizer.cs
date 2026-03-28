using System.Text.RegularExpressions;
using Manso.Domain;

namespace Manso.Application;

public sealed class RequestNormalizer : IRequestNormalizer
{
    private static readonly Regex UrlRegex = new(@"https?://[^\s<>()]+", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private readonly RequestNormalizationOptions _options;

    public RequestNormalizer(RequestNormalizationOptions options)
    {
        _options = options;
    }

    public Task<NormalizationResult> NormalizeAsync(RawRunRequest request, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var generationMode = ParseEnum(
            request.TriggerInputs.GenerationMode,
            _options.DefaultGenerationMode,
            "triggerInputs.generationMode");
        var workflowPass = ParseEnum(
            request.TriggerInputs.WorkflowPass,
            _options.DefaultWorkflowPass,
            "triggerInputs.workflowPass");
        var testScope = ParseEnum(
            request.TriggerInputs.TestScope,
            _options.DefaultTestScope,
            "triggerInputs.testScope");
        var coverageIntent = ParseEnum(
            request.TriggerInputs.CoverageIntent,
            _options.DefaultCoverageIntent,
            "triggerInputs.coverageIntent");
        var outputTarget = ParseEnum(
            request.TriggerInputs.OutputTarget,
            _options.DefaultOutputTarget,
            "triggerInputs.outputTarget");

        var warnings = new List<RunWarning>();
        if (!string.IsNullOrWhiteSpace(request.TriggerInputs.BranchOrPrOverride))
        {
            warnings.Add(new RunWarning(
                "branch_or_pr_override_ignored",
                "Manual branchOrPrOverride input is ignored. Repository code context is resolved only from Jira development information."));
        }

        var documentationLinks = BuildExplicitDocumentationLinks(request, warnings);
        var normalizedRequest = new NormalizedRunRequest(
            request.Issue.Key.Trim(),
            request.Issue.Url.Trim(),
            generationMode,
            workflowPass,
            testScope,
            FirstNonEmpty(request.TriggerInputs.RepositoryOverride, request.IssueFields.ConfiguredRepository),
            null,
            documentationLinks,
            coverageIntent,
            outputTarget,
            new RequestedBy(
                NormalizeOptional(request.RequestedBy.AccountId),
                NormalizeOptional(request.RequestedBy.DisplayName),
                NormalizeOptional(request.RequestedBy.Email)),
            documentationLinks.Count == 0 ? DocumentationMode.ExplicitOnlyNoDocs : DocumentationMode.ExplicitOnly);

        return Task.FromResult(new NormalizationResult(normalizedRequest, warnings));
    }

    private List<string> BuildExplicitDocumentationLinks(RawRunRequest request, List<RunWarning> warnings)
    {
        var orderedCandidates = new List<string>();
        orderedCandidates.AddRange(ExtractUrls(request.Issue.Description));
        orderedCandidates.AddRange(SplitLines(request.IssueFields.DocumentationLinks));
        orderedCandidates.AddRange(SplitLines(request.TriggerInputs.ExtraDocumentationLinks));

        var results = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var candidate in orderedCandidates)
        {
            if (!TryNormalizeDocumentationUrl(candidate, out var normalizedUrl, out var warningMessage))
            {
                warnings.Add(new RunWarning("documentation_link_ignored", warningMessage!));
                continue;
            }

            if (seen.Add(normalizedUrl!))
            {
                results.Add(normalizedUrl!);
            }
        }

        return results;
    }

    private bool TryNormalizeDocumentationUrl(string candidate, out string? normalizedUrl, out string? warningMessage)
    {
        normalizedUrl = null;
        warningMessage = null;

        if (!Uri.TryCreate(candidate.Trim().TrimEnd('.', ',', ';'), UriKind.Absolute, out var uri))
        {
            warningMessage = $"Ignored documentation value because it is not a valid absolute URL: '{candidate}'.";
            return false;
        }

        if (!uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            warningMessage = $"Ignored documentation URL because only HTTPS links are allowed: '{candidate}'.";
            return false;
        }

        if (_options.AllowedConfluenceHosts.Length > 0 &&
            !_options.AllowedConfluenceHosts.Contains(uri.Host, StringComparer.OrdinalIgnoreCase))
        {
            warningMessage = $"Ignored documentation URL because host '{uri.Host}' is not allowed.";
            return false;
        }

        if (!uri.AbsolutePath.Contains("/wiki/", StringComparison.OrdinalIgnoreCase))
        {
            warningMessage = $"Ignored documentation URL because it is not a Confluence wiki URL: '{candidate}'.";
            return false;
        }

        normalizedUrl = uri.ToString();
        return true;
    }

    private static IReadOnlyList<string> ExtractUrls(string input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return Array.Empty<string>();
        }

        return UrlRegex.Matches(input)
            .Select(match => match.Value)
            .ToArray();
    }

    private static IReadOnlyList<string> SplitLines(string? input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return Array.Empty<string>();
        }

        return input
            .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .ToArray();
    }

    private static TEnum ParseEnum<TEnum>(string? input, TEnum fallback, string fieldName)
        where TEnum : struct, Enum
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return fallback;
        }

        if (Enum.TryParse<TEnum>(input, ignoreCase: true, out var parsed))
        {
            return parsed;
        }

        throw new RequestValidationException(
            $"{fieldName} value is not supported.",
            fieldName,
            input);
    }

    private static string? FirstNonEmpty(string? preferred, string? fallback)
        => NormalizeOptional(preferred) ?? NormalizeOptional(fallback);

    private static string? NormalizeOptional(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
