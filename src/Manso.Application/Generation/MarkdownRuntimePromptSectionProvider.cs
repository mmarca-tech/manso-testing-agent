using Manso.Domain;
using Microsoft.Extensions.Logging;
using System.Text;

namespace Manso.Application;

public sealed class MarkdownRuntimePromptSectionProvider : IRuntimePromptSectionProvider
{
    private static readonly string[] ScenarioQualityKeywords =
    [
        "specific",
        "Preconditions",
        "Expected results",
        "Missing information",
        "avoid duplicating",
    ];

    private static readonly string[] RuntimeRuleKeywords =
    [
        "Jira development metadata",
        "manual branch or PR override",
        "Gherkin-first",
        "widen file scope",
        "widen repo scope",
        "widen retrieval scope",
    ];

    private readonly RuntimePromptOptions _options;
    private readonly ILogger<MarkdownRuntimePromptSectionProvider> _logger;

    public MarkdownRuntimePromptSectionProvider(
        RuntimePromptOptions options,
        ILogger<MarkdownRuntimePromptSectionProvider> logger)
    {
        _options = options;
        _logger = logger;
    }

    public GenerationContextSection BuildScenarioGenerationSection(
        TestScope testScope,
        WorkflowPass workflowPass)
    {
        try
        {
            var runtimeRoot = ResolveRuntimeRoot();
            if (runtimeRoot is null)
            {
                _logger.LogWarning(
                    "Runtime prompt root '{ConfiguredRootPath}' was not found. Falling back to built-in guardrails.",
                    GetConfiguredRootPath());
                return BuildFallbackSection(testScope, workflowPass);
            }

            var personalityMarkdown = TryReadMarkdown(Path.Combine(runtimeRoot, "agent-personality.md"));
            var scenarioGuardrailsMarkdown = TryReadMarkdown(Path.Combine(runtimeRoot, "scenario-generation-guardrails.md"));
            if (string.IsNullOrWhiteSpace(personalityMarkdown) || string.IsNullOrWhiteSpace(scenarioGuardrailsMarkdown))
            {
                _logger.LogWarning(
                    "Runtime prompt markdown was incomplete under '{RuntimeRoot}'. Falling back to built-in guardrails.",
                    runtimeRoot);
                return BuildFallbackSection(testScope, workflowPass);
            }

            return new GenerationContextSection(
                "runtime_guardrails",
                "RUNTIME GUARDRAILS",
                BuildControlledSection(testScope, workflowPass, personalityMarkdown, scenarioGuardrailsMarkdown));
        }
        catch (ArgumentException ex)
        {
            _logger.LogWarning(
                ex,
                "Runtime prompt path configuration '{ConfiguredRootPath}' was invalid. Falling back to built-in guardrails.",
                _options.RootPath);
            return BuildFallbackSection(testScope, workflowPass);
        }
        catch (NotSupportedException ex)
        {
            _logger.LogWarning(
                ex,
                "Runtime prompt path configuration '{ConfiguredRootPath}' was not supported. Falling back to built-in guardrails.",
                _options.RootPath);
            return BuildFallbackSection(testScope, workflowPass);
        }
    }

    private static GenerationContextSection BuildFallbackSection(
        TestScope testScope,
        WorkflowPass workflowPass)
        => new(
            "runtime_guardrails",
            "RUNTIME GUARDRAILS",
            $$"""
            Apply these runtime guardrails as operational policy for scenario generation.

            Persona:
            - Be rigorous, skeptical, and exact.
            - Keep scenarios bounded to retrieved evidence and state uncertainty explicitly.
            - Make every scenario traceable to a requirement, behavior change, risk, or code-path clue.

            Grounding and scope:
            - Treat Jira issue details and repository diff context as primary sources of truth.
            - Use Confluence only when it is explicitly linked and clearly relevant.
            - Refuse uncontrolled scope expansion or invented hidden behavior.

            Scenario quality:
            - Keep scenarios specific, bounded, and actionable.
            - Make preconditions explicit, steps minimal, and expected results observable.
            - Avoid duplicating the same idea with minor wording changes.

            Runtime safeguards:
            - Treat Jira development metadata as the authoritative repository-context source for iteration 1.
            - Do not introduce manual branch or PR override as a competing runtime path.
            - Keep scenario artifacts Gherkin-first for reviewability.
            - Do not silently widen file scope, repo scope, or retrieval scope.

            Requested scope for this run: {{testScope}}.
            Workflow pass for this run: {{workflowPass}}.
            """);

    private static string BuildControlledSection(
        TestScope testScope,
        WorkflowPass workflowPass,
        string personalityMarkdown,
        string scenarioGuardrailsMarkdown)
    {
        var personalitySection = GetSectionContent(personalityMarkdown, "Personality");
        var personalitySentences = SplitSentences(personalitySection)
            .Where(sentence =>
                sentence.Contains("rigorous", StringComparison.OrdinalIgnoreCase) ||
                sentence.Contains("do not guess", StringComparison.OrdinalIgnoreCase) ||
                sentence.Contains("traceable", StringComparison.OrdinalIgnoreCase) ||
                sentence.Contains("provenance", StringComparison.OrdinalIgnoreCase))
            .Take(4)
            .ToArray();

        var coreBehaviorBullets = GetBullets(personalityMarkdown, "Core behaviors");
        var selectedCoreBehaviorBullets = coreBehaviorBullets
            .Where(bullet =>
                bullet.Contains("primary sources", StringComparison.OrdinalIgnoreCase) ||
                bullet.Contains("Confluence", StringComparison.OrdinalIgnoreCase) ||
                bullet.Contains("scope expansion", StringComparison.OrdinalIgnoreCase) ||
                bullet.Contains("facts, inferences, and assumptions", StringComparison.OrdinalIgnoreCase))
            .ToArray();

        var outputQualityBullets = GetBullets(personalityMarkdown, "Expected output qualities");
        var selectedQualityBullets = outputQualityBullets
            .Where(bullet => ScenarioQualityKeywords.Any(keyword => bullet.Contains(keyword, StringComparison.OrdinalIgnoreCase)))
            .ToArray();

        var runtimeRuleBullets = GetBullets(scenarioGuardrailsMarkdown, "Runtime rules");
        var implementationStanceBullets = GetBullets(scenarioGuardrailsMarkdown, "Implementation stance");
        var selectedRuntimeBullets = runtimeRuleBullets
            .Concat(implementationStanceBullets)
            .Where(bullet => RuntimeRuleKeywords.Any(keyword => bullet.Contains(keyword, StringComparison.OrdinalIgnoreCase)))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var builder = new StringBuilder();
        builder.AppendLine("Apply these runtime guardrails as operational policy for scenario generation.");
        builder.AppendLine();
        AppendGroup(builder, "Persona", personalitySentences);
        AppendGroup(builder, "Grounding and scope", selectedCoreBehaviorBullets);
        AppendGroup(builder, "Scenario quality", selectedQualityBullets);
        AppendGroup(builder, "Runtime safeguards", selectedRuntimeBullets);
        builder.AppendLine($"Requested scope for this run: {testScope}.");
        builder.AppendLine($"Workflow pass for this run: {workflowPass}.");

        return builder.ToString().Trim();
    }

    private string? ResolveRuntimeRoot()
    {
        var configuredRootPath = GetConfiguredRootPath();
        var candidates = new List<string>();
        AddCandidate(candidates, configuredRootPath);
        AddCandidate(candidates, TryCombine(Directory.GetCurrentDirectory(), configuredRootPath));
        AddCandidate(candidates, TryCombine(AppContext.BaseDirectory, configuredRootPath));

        foreach (var candidate in candidates)
        {
            var resolved = ResolveByWalkingUp(candidate);
            if (resolved is not null)
            {
                return resolved;
            }
        }

        return null;
    }

    private static string? ResolveByWalkingUp(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return null;
        }

        if (Directory.Exists(path) && ContainsRuntimeMarkdown(path))
        {
            return Path.GetFullPath(path);
        }

        var baseDirectory = Directory.Exists(path)
            ? new DirectoryInfo(path)
            : new DirectoryInfo(Path.GetDirectoryName(path) ?? path);

        while (baseDirectory is not null)
        {
            var candidate = Path.Combine(baseDirectory.FullName, "agent-runtime");
            if (Directory.Exists(candidate) && ContainsRuntimeMarkdown(candidate))
            {
                return candidate;
            }

            baseDirectory = baseDirectory.Parent;
        }

        return null;
    }

    private static bool ContainsRuntimeMarkdown(string path)
        => File.Exists(Path.Combine(path, "agent-personality.md")) &&
           File.Exists(Path.Combine(path, "scenario-generation-guardrails.md"));

    private string? TryReadMarkdown(string path)
    {
        try
        {
            return File.Exists(path) ? File.ReadAllText(path) : null;
        }
        catch (IOException ex)
        {
            _logger.LogWarning(ex, "Failed to read runtime prompt markdown from '{Path}'.", path);
            return null;
        }
        catch (UnauthorizedAccessException ex)
        {
            _logger.LogWarning(ex, "Failed to access runtime prompt markdown from '{Path}'.", path);
            return null;
        }
        catch (ArgumentException ex)
        {
            _logger.LogWarning(ex, "Invalid runtime prompt markdown path '{Path}'.", path);
            return null;
        }
        catch (NotSupportedException ex)
        {
            _logger.LogWarning(ex, "Unsupported runtime prompt markdown path '{Path}'.", path);
            return null;
        }
    }

    private static string GetSectionContent(string markdown, string heading)
    {
        var lines = markdown.Replace("\r\n", "\n").Split('\n');
        var collected = new List<string>();
        var insideSection = false;

        foreach (var rawLine in lines)
        {
            var line = rawLine.TrimEnd();
            if (line.StartsWith("## ", StringComparison.Ordinal))
            {
                if (insideSection)
                {
                    break;
                }

                insideSection = line.Equals($"## {heading}", StringComparison.OrdinalIgnoreCase);
                continue;
            }

            if (insideSection)
            {
                collected.Add(line);
            }
        }

        return string.Join("\n", collected).Trim();
    }

    private static IReadOnlyList<string> GetBullets(string markdown, string heading)
        => GetSectionContent(markdown, heading)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(line => line.StartsWith("- ", StringComparison.Ordinal))
            .Select(line => line[2..].Trim())
            .ToArray();

    private static IReadOnlyList<string> SplitSentences(string content)
    {
        var normalized = string.Join(
            " ",
            content.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));

        return normalized
            .Split('.', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(sentence => $"{sentence.Trim()}.")
            .ToArray();
    }

    private static void AppendGroup(StringBuilder builder, string title, IReadOnlyList<string> entries)
    {
        if (entries.Count == 0)
        {
            return;
        }

        builder.AppendLine($"{title}:");
        foreach (var entry in entries)
        {
            builder.AppendLine($"- {entry}");
        }

        builder.AppendLine();
    }

    private static void AddCandidate(ICollection<string> candidates, string? candidate)
    {
        if (!string.IsNullOrWhiteSpace(candidate))
        {
            candidates.Add(candidate);
        }
    }

    private static string? TryCombine(string basePath, string relativePath)
    {
        try
        {
            return Path.Combine(basePath, relativePath);
        }
        catch (ArgumentException)
        {
            return null;
        }
        catch (NotSupportedException)
        {
            return null;
        }
    }

    private string GetConfiguredRootPath()
        => string.IsNullOrWhiteSpace(_options.RootPath)
            ? RuntimePromptOptions.DefaultRootPath
            : _options.RootPath.Trim();
}
