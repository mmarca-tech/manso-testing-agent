import type { ConfluenceImpactPack } from "../../domain/confluenceImpact/schema.js";

export function renderConfluenceImpactMarkdown(pack: ConfluenceImpactPack): string {
  const lines: string[] = [];

  lines.push(`# Confluence Impact for ${pack.ticket.key}: ${pack.ticket.title}`, "");
  lines.push("## Summary", "");
  lines.push(tableRows([
    ["Ticket", pack.ticket.key],
    ["Pages", String(pack.pages.length)],
    ["LLM", `${pack.provenance.llm.provider} / ${pack.provenance.llm.model}`],
  ]));

  lines.push("", "## Pages", "");
  if (pack.pages.length === 0) {
    lines.push("_No linked Confluence pages found in the source context._", "");
  } else {
    for (const item of pack.pages) {
      lines.push(`### ${item.page.title}`, "");
      lines.push(tableRows([
        ["Space", item.page.space],
        ["Updated", item.page.updatedAt],
        ["URL", item.page.url],
        ["Content Source", item.extraction.contentSource],
        ["Body Available", String(item.extraction.bodyAvailable)],
        ["Body Length", String(item.extraction.bodyLength)],
      ]));

      lines.push("", "#### Impact", "", item.impact.summary, "");
      lines.push(`Ticket relevance: ${item.impact.ticketRelevance}`, "");
      lines.push("Impacted areas:");
      pushList(lines, item.impact.impactedAreas);
      lines.push("", "Decisions or constraints:");
      pushList(lines, item.impact.decisionsOrConstraints);
      lines.push("", "Risks:");
      pushList(lines, item.impact.risks);
      lines.push("", "Testing notes:");
      pushList(lines, item.impact.testingNotes);
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

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}
