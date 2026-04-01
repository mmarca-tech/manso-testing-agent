namespace Manso.Infrastructure;

internal static class UnifiedDiffBuilder
{
    public static string Build(string path, string? beforeContent, string? afterContent, int maxDiffLines)
    {
        var beforeLines = SplitLines(beforeContent);
        var afterLines = SplitLines(afterContent);

        var result = new List<string>
        {
            $"--- a/{path.TrimStart('/')}",
            $"+++ b/{path.TrimStart('/')}",
        };

        if (beforeContent is null)
        {
            result.AddRange(afterLines.Select(line => $"+{line}"));
            return Trim(result, maxDiffLines);
        }

        if (afterContent is null)
        {
            result.AddRange(beforeLines.Select(line => $"-{line}"));
            return Trim(result, maxDiffLines);
        }

        if ((long)beforeLines.Length * afterLines.Length > 40_000)
        {
            result.AddRange(BuildFallback(beforeLines, afterLines));
            return Trim(result, maxDiffLines);
        }

        var operations = BuildOperations(beforeLines, afterLines);
        foreach (var operation in operations)
        {
            switch (operation.Kind)
            {
                case DiffOperationKind.Equal:
                    result.Add($" {operation.Line}");
                    break;
                case DiffOperationKind.Add:
                    result.Add($"+{operation.Line}");
                    break;
                case DiffOperationKind.Remove:
                    result.Add($"-{operation.Line}");
                    break;
            }
        }

        return Trim(result, maxDiffLines);
    }

    private static string[] SplitLines(string? content)
        => content?.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n') ?? Array.Empty<string>();

    private static IReadOnlyList<DiffOperation> BuildOperations(string[] beforeLines, string[] afterLines)
    {
        var lengths = new int[beforeLines.Length + 1, afterLines.Length + 1];
        for (var i = beforeLines.Length - 1; i >= 0; i--)
        {
            for (var j = afterLines.Length - 1; j >= 0; j--)
            {
                lengths[i, j] = beforeLines[i] == afterLines[j]
                    ? lengths[i + 1, j + 1] + 1
                    : Math.Max(lengths[i + 1, j], lengths[i, j + 1]);
            }
        }

        var operations = new List<DiffOperation>();
        var beforeIndex = 0;
        var afterIndex = 0;
        while (beforeIndex < beforeLines.Length && afterIndex < afterLines.Length)
        {
            if (beforeLines[beforeIndex] == afterLines[afterIndex])
            {
                operations.Add(new DiffOperation(DiffOperationKind.Equal, beforeLines[beforeIndex]));
                beforeIndex++;
                afterIndex++;
            }
            else if (lengths[beforeIndex + 1, afterIndex] >= lengths[beforeIndex, afterIndex + 1])
            {
                operations.Add(new DiffOperation(DiffOperationKind.Remove, beforeLines[beforeIndex]));
                beforeIndex++;
            }
            else
            {
                operations.Add(new DiffOperation(DiffOperationKind.Add, afterLines[afterIndex]));
                afterIndex++;
            }
        }

        while (beforeIndex < beforeLines.Length)
        {
            operations.Add(new DiffOperation(DiffOperationKind.Remove, beforeLines[beforeIndex++]));
        }

        while (afterIndex < afterLines.Length)
        {
            operations.Add(new DiffOperation(DiffOperationKind.Add, afterLines[afterIndex++]));
        }

        return operations;
    }

    private static IEnumerable<string> BuildFallback(string[] beforeLines, string[] afterLines)
    {
        var length = Math.Max(beforeLines.Length, afterLines.Length);
        for (var index = 0; index < length; index++)
        {
            var before = index < beforeLines.Length ? beforeLines[index] : null;
            var after = index < afterLines.Length ? afterLines[index] : null;

            if (before == after)
            {
                if (before is not null)
                {
                    yield return $" {before}";
                }

                continue;
            }

            if (before is not null)
            {
                yield return $"-{before}";
            }

            if (after is not null)
            {
                yield return $"+{after}";
            }
        }
    }

    private static string Trim(List<string> lines, int maxDiffLines)
    {
        if (lines.Count <= maxDiffLines)
        {
            return string.Join(Environment.NewLine, lines);
        }

        var trimmed = lines.Take(maxDiffLines).ToList();
        trimmed.Add($"... diff truncated to {maxDiffLines} lines");
        return string.Join(Environment.NewLine, trimmed);
    }

    private sealed record DiffOperation(DiffOperationKind Kind, string Line);

    private enum DiffOperationKind
    {
        Equal,
        Add,
        Remove,
    }
}
