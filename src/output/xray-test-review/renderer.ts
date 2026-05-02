import type { XrayTestReviewPack } from "../../domain/xrayTestReview/schema.js";

export function renderXrayTestReviewMarkdown(pack: XrayTestReviewPack): string {
  const lines: string[] = [];

  lines.push(`# Xray Test Review for ${pack.ticket.key}: ${pack.ticket.title}`, "");
  lines.push("## Summary", "");
  lines.push(tableRows([
    ["Ticket", pack.ticket.key],
    ["Reviewed Tests", String(pack.review.testCases.length)],
    ["LLM", pack.provenance.llm ? `${pack.provenance.llm.provider} / ${pack.provenance.llm.model}` : undefined],
  ]));

  lines.push("", pack.review.overallSummary, "");
  lines.push("Covered acceptance criteria:");
  pushList(lines, pack.review.coveredAcceptanceCriteria);
  lines.push("", "Gaps or ambiguities:");
  pushList(lines, pack.review.gapsOrAmbiguities);

  lines.push("", "## Linked Xray Tests", "");
  if (pack.review.testCases.length === 0) {
    lines.push("_No linked Xray test cases found in the source context._", "");
  } else {
    for (const testCase of pack.review.testCases) {
      lines.push(`### ${testCase.key}: ${testCase.title}`, "");
      lines.push(tableRows([
        ["Status", testCase.status],
        ["Relationship", testCase.relationship],
        ["URL", testCase.url],
        ["Update Recommendation", testCase.updateRecommendation],
      ]));

      lines.push("", testCase.summary, "");
      lines.push("Covered acceptance criteria:");
      pushList(lines, testCase.coveredAcceptanceCriteria);
      lines.push("", "Covered behaviors:");
      pushList(lines, testCase.coveredBehaviors);
      lines.push("", "Test data or preconditions:");
      pushList(lines, testCase.testDataOrPreconditions);
      lines.push("", "Gaps or ambiguities:");
      pushList(lines, testCase.gapsOrAmbiguities);
      lines.push("", `Rationale: ${testCase.rationale}`, "");
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
