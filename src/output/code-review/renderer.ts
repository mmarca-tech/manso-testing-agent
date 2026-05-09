import type { CodeReviewPack } from "../../domain/codeReview/schema.js";

export function renderCodeReviewMarkdown(pack: CodeReviewPack): string {
  const lines: string[] = [];

  lines.push(`# Manso Code Review`, "");
  lines.push(tableRows([
    ["Pull Request", `[${pack.pullRequest.title}](${pack.pullRequest.url})`],
    ["Ticket", pack.ticket ? linkOrText(pack.ticket.ticket.key, pack.ticket.ticket.url) : pack.detectedTicketKey],
    ["Recommendation", pack.review.approvalRecommendation],
    ["Findings", String(pack.review.findings.length)],
    ["LLM", `${pack.provenance.llm.provider} / ${pack.provenance.llm.model}`],
  ]));

  lines.push("", "## Summary", "", pack.review.summary, "");
  lines.push("## Business Review", "", pack.review.businessImpact, "");
  lines.push("## Technical Review", "", pack.review.technicalAssessment, "");

  lines.push("## Findings", "");
  if (pack.review.findings.length === 0) {
    lines.push("_No specific findings._", "");
  } else {
    for (const finding of pack.review.findings) {
      lines.push(`### ${finding.severity.toUpperCase()} ${finding.category}: ${finding.title}`, "");
      lines.push(finding.details, "");
      lines.push(`Recommendation: ${finding.recommendation}`, "");
      if (finding.filePath) {
        lines.push(`Location: ${finding.filePath}${finding.line ? `:${finding.line}` : ""}`, "");
      }
      lines.push("Evidence:");
      pushList(lines, finding.evidence);
      lines.push("");
    }
  }

  if (pack.review.questions.length > 0) {
    lines.push("## Questions", "");
    pushList(lines, pack.review.questions);
    lines.push("");
  }

  if (pack.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of pack.warnings) {
      lines.push(`- ${warning.section}${warning.toolName ? `/${warning.toolName}` : ""}: ${warning.message}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
}

export function renderCodeReviewComment(pack: CodeReviewPack): string {
  const lines: string[] = [];

  lines.push("## Manso Code Review", "");
  lines.push(`**Recommendation:** ${pack.review.approvalRecommendation}`, "");
  if (pack.ticket) {
    lines.push(`**Ticket:** ${pack.ticket.ticket.key}: ${pack.ticket.ticket.title}`, "");
  } else if (pack.detectedTicketKey) {
    lines.push(`**Detected ticket:** ${pack.detectedTicketKey}`, "");
  }

  lines.push(pack.review.summary, "");
  lines.push("**Business:**", "", pack.review.businessImpact, "");
  lines.push("**Technical:**", "", pack.review.technicalAssessment, "");

  if (pack.review.findings.length > 0) {
    lines.push("### Findings", "");
    for (const finding of pack.review.findings) {
      lines.push(`- **${finding.severity.toUpperCase()} ${finding.category}: ${finding.title}**`);
      lines.push(`  ${finding.details}`);
      lines.push(`  Recommendation: ${finding.recommendation}`);
      if (finding.filePath) {
        lines.push(`  Location: ${finding.filePath}${finding.line ? `:${finding.line}` : ""}`);
      }
    }
    lines.push("");
  } else {
    lines.push("No specific automated findings.", "");
  }

  if (pack.review.questions.length > 0) {
    lines.push("### Questions", "");
    pushList(lines, pack.review.questions);
    lines.push("");
  }

  lines.push("_Automated review generated from PR diff and Jira context. Use as reviewer input, not as a replacement for human approval._");
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

function linkOrText(label: string, url: string | undefined): string {
  return url ? `[${label}](${url})` : label;
}
