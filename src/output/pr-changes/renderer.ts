import type { PrChangesPack } from "../../domain/prChanges/schema.js";

export function renderPrChangesMarkdown(pack: PrChangesPack): string {
  const lines: string[] = [];

  lines.push(`# PR Changes for ${pack.ticket.key}: ${pack.ticket.title}`, "");
  lines.push("## Summary", "");
  lines.push(tableRows([
    ["Ticket", pack.ticket.key],
    ["Pull Requests", String(pack.pullRequests.length)],
    ["Files Changed", String(pack.pullRequests.reduce((sum, pullRequest) => sum + pullRequest.diff.files.length, 0))],
    ["Source Files Fetched", String(pack.pullRequests.reduce((sum, pullRequest) => sum + pullRequest.diff.sourceFiles.length, 0))],
    ["Commits", String(pack.pullRequests.reduce((sum, pullRequest) => sum + pullRequest.diff.commits.length, 0))],
    ["LLM", `${pack.provenance.llm.provider} / ${pack.provenance.llm.model}`],
  ]));

  lines.push("", "## Pull Requests", "");
  if (pack.pullRequests.length === 0) {
    lines.push("_No pull requests found in the source context._", "");
  } else {
    for (const pullRequest of pack.pullRequests) {
      lines.push(`### ${pullRequest.title}`, "");
      lines.push(tableRows([
        ["Status", pullRequest.status],
        ["Repository", pullRequest.repository],
        ["Provider", pullRequest.provider],
        ["Source Branch", pullRequest.sourceBranch],
        ["Target Branch", pullRequest.targetBranch],
        ["Author", pullRequest.author ? [pullRequest.author.name, pullRequest.author.email].filter(Boolean).join(" / ") : undefined],
        ["Updated", pullRequest.lastUpdatedAt],
        ["URL", pullRequest.url],
      ]));

      lines.push("", "#### Understanding", "", pullRequest.understanding.summary, "");
      lines.push("Change areas:");
      pushList(lines, pullRequest.understanding.changeAreas);
      lines.push("", "Risks:");
      pushList(lines, pullRequest.understanding.risks);
      lines.push("", "Testing notes:");
      pushList(lines, pullRequest.understanding.testingNotes);

      lines.push("", "#### Diff Metadata", "");
      lines.push(tableRows([
        ["Provider", pullRequest.diff.provider],
        ["Change Counts", formatChangeCounts(pullRequest.diff.changeCounts)],
        ["All Changes Included", pullRequest.diff.allChangesIncluded === undefined ? undefined : String(pullRequest.diff.allChangesIncluded)],
      ]));

      lines.push("", "Files:");
      if (pullRequest.diff.files.length === 0) {
        lines.push("_No file changes found._");
      } else {
        for (const file of pullRequest.diff.files) {
          lines.push(`- ${file.changeType} ${file.path}${file.originalPath ? ` (from ${file.originalPath})` : ""}`);
        }
      }

      lines.push("", "Source files:");
      if (pullRequest.diff.sourceFiles.length === 0) {
        lines.push("_No source file snippets fetched._");
      } else {
        for (const file of pullRequest.diff.sourceFiles) {
          lines.push(
            `- ${file.role}${file.changeType ? `/${file.changeType}` : ""} ${file.path}${file.language ? ` (${file.language})` : ""}${file.truncated ? " [truncated]" : ""}${file.reason ? ` - ${file.reason}` : ""}`,
          );
        }
      }

      lines.push("", "Commits:");
      if (pullRequest.diff.commits.length === 0) {
        lines.push("_No commits found._");
      } else {
        for (const commit of pullRequest.diff.commits) {
          lines.push(`- ${commit.id.slice(0, 12)}${commit.comment ? `: ${commit.comment}` : ""}${commit.author?.name ? ` by ${commit.author.name}` : ""}`);
        }
      }

      lines.push("");
    }
  }

  lines.push("## Warnings", "");
  if (pack.warnings.length === 0) {
    lines.push("_No warnings._", "");
  } else {
    for (const warning of pack.warnings) {
      lines.push(`- ${warning.section}${warning.toolName ? `/${warning.toolName}` : ""}: ${warning.message}`);
    }
    lines.push("");
  }

  lines.push("## Provenance", "");
  lines.push(`Generated: ${pack.provenance.generatedAt}`, "");
  lines.push(`Source context: ${pack.provenance.sourceContextPath}`, "");
  if (pack.provenance.tools.length === 0) {
    lines.push("_No source calls were recorded._");
  } else {
    for (const tool of pack.provenance.tools) {
      lines.push(`- ${tool.calledAt} ${tool.method} via ${tool.toolName}: ${tool.success ? "success" : `failed (${tool.message ?? "unknown error"})`}`);
    }
  }

  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
}

function pushList(lines: string[], values: string[]): void {
  if (values.length === 0) {
    lines.push("_None._");
    return;
  }

  for (const value of values) {
    lines.push(`- ${value}`);
  }
}

function tableRows(rows: Array<[string, string | undefined]>): string {
  const visibleRows = rows.filter(([, value]) => value && value.trim().length > 0);
  if (visibleRows.length === 0) {
    return "_No metadata found._";
  }

  return ["| Field | Value |", "| --- | --- |", ...visibleRows.map(([key, value]) => `| ${escapeCell(key)} | ${escapeCell(value ?? "")} |`)].join("\n");
}

function formatChangeCounts(counts: Record<string, number>): string | undefined {
  const entries = Object.entries(counts);
  return entries.length > 0 ? entries.map(([key, value]) => `${key}: ${value}`).join(", ") : undefined;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}
