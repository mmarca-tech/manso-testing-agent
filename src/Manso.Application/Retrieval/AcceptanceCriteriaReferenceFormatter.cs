using Manso.Domain;
using System.Text;
using System.Text.RegularExpressions;

namespace Manso.Application;

public static class AcceptanceCriteriaReferenceFormatter
{
    private static readonly Regex ListMarkerRegex = new(
        @"^(?:[-*•]\s+|\d+[\.\)]\s+)",
        RegexOptions.Compiled);

    private static readonly Regex ReferenceLineRegex = new(
        @"^(AC-\d+)\s*:",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public static IReadOnlyList<AcceptanceCriterionReference> Extract(string? rawAcceptanceCriteria)
    {
        if (string.IsNullOrWhiteSpace(rawAcceptanceCriteria))
        {
            return Array.Empty<AcceptanceCriterionReference>();
        }

        var criteria = new List<string>();
        var current = new StringBuilder();
        foreach (var rawLine in rawAcceptanceCriteria
                     .Replace("\r\n", "\n", StringComparison.Ordinal)
                     .Split('\n', StringSplitOptions.TrimEntries))
        {
            if (string.IsNullOrWhiteSpace(rawLine))
            {
                FlushCurrentCriterion(criteria, current);
                continue;
            }

            var isNewCriterion = ListMarkerRegex.IsMatch(rawLine);
            var line = ListMarkerRegex.Replace(rawLine, string.Empty).Trim();
            if (isNewCriterion)
            {
                FlushCurrentCriterion(criteria, current);
            }
            else if (current.Length > 0)
            {
                current.Append(' ');
            }

            current.Append(line);
        }

        FlushCurrentCriterion(criteria, current);

        return criteria
            .Select((text, index) => new AcceptanceCriterionReference($"AC-{index + 1}", text))
            .ToArray();
    }

    public static string BuildSectionContent(string? rawAcceptanceCriteria)
    {
        var criteria = Extract(rawAcceptanceCriteria);
        if (criteria.Count == 0)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        foreach (var criterion in criteria)
        {
            builder.AppendLine($"{criterion.Reference}: {criterion.Text}");
        }

        return builder.ToString().Trim();
    }

    public static IReadOnlySet<string> ExtractAvailableReferences(GenerationContextBundle bundle)
    {
        var acceptanceCriteriaSection = bundle.Sections.FirstOrDefault(section =>
            section.Key.Equals("acceptance_criteria", StringComparison.OrdinalIgnoreCase));
        if (acceptanceCriteriaSection is null || string.IsNullOrWhiteSpace(acceptanceCriteriaSection.Content))
        {
            return new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        }

        return acceptanceCriteriaSection.Content
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(line => ReferenceLineRegex.Match(line))
            .Where(match => match.Success)
            .Select(match => match.Groups[1].Value)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    private static void FlushCurrentCriterion(ICollection<string> criteria, StringBuilder current)
    {
        if (current.Length == 0)
        {
            return;
        }

        criteria.Add(current.ToString().Trim());
        current.Clear();
    }
}
