import type { XrayTestDefinitionsPack } from "../../domain/xrayTestDefinitions/schema.js";

export function renderXrayTestDefinitionsMarkdown(pack: XrayTestDefinitionsPack): string {
  const lines: string[] = [];

  lines.push(`# Xray Test Definitions for ${pack.ticket.key}: ${pack.ticket.title}`, "");
  lines.push("## Summary", "");
  lines.push(tableRows([
    ["Ticket", pack.ticket.key],
    ["Definitions", String(pack.definitions.length)],
    ["Source context", pack.provenance.sourceContextPath],
  ]));

  lines.push("", "## Definitions", "");
  if (pack.definitions.length === 0) {
    lines.push("_No linked Xray test definitions were fetched._", "");
  } else {
    for (const definition of pack.definitions) {
      lines.push(`### ${definition.key}: ${definition.title}`, "");
      lines.push(tableRows([
        ["Issue ID", definition.issueId],
        ["Status", definition.status],
        ["Test Type", definition.testType],
        ["Labels", definition.labels.length > 0 ? definition.labels.join(", ") : undefined],
      ]));
      if (definition.description) {
        lines.push("", "Description:", "", definition.description, "");
      }
      if (definition.gherkin) {
        lines.push("", "Gherkin:", "", "```gherkin", definition.gherkin, "```", "");
      }
      lines.push("", "Steps:");
      if (definition.steps.length === 0) {
        lines.push("_No manual steps._", "");
      } else {
        for (const [index, step] of definition.steps.entries()) {
          lines.push(`${index + 1}. ${step.action}`);
          if (step.data) {
            lines.push(`   Data: ${step.data}`);
          }
          if (step.expectedResult) {
            lines.push(`   Expected: ${step.expectedResult}`);
          }
        }
        lines.push("");
      }
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
  if (pack.provenance.tools.length === 0) {
    lines.push("_No source calls were recorded._");
  } else {
    for (const tool of pack.provenance.tools) {
      lines.push(`- ${tool.calledAt} ${tool.method} via ${tool.toolName}: ${tool.success ? "success" : `failed (${tool.message ?? "unknown error"})`}`);
    }
  }

  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
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
