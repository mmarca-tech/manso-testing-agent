import type { CodeReviewFinding, CodeReviewPack } from "../../domain/codeReview/schema.js";

/** Complete Markdown artifact, including every finding regardless of posting mode. */
export function renderCodeReviewMarkdown(pack: CodeReviewPack): string {
  return renderReview(pack, pack.review.findings);
}

/** Summary omits findings already posted inline; unlocated findings stay visible. */
export function renderCodeReviewSummary(pack: CodeReviewPack, inlineFindingIndexes: ReadonlySet<number>): string {
  return renderReview(pack, pack.review.findings.filter((_, index) => !inlineFindingIndexes.has(index)), inlineFindingIndexes.size);
}

/** Focused inline comment body using the same evidence as the complete report. */
export function renderCodeReviewFinding(finding: CodeReviewFinding): string {
  return [
    `### Manso: ${finding.severity.toUpperCase()} ${finding.category}: ${finding.title}`, "",
    finding.details, "", `**Recommendation:** ${finding.recommendation}`, "",
    "**Evidence:**", ...finding.evidence.map((evidence) => `- ${evidence}`), "",
    "_Automated advisory finding, not a replacement for human review._", "",
  ].join("\n");
}

function renderReview(pack: CodeReviewPack, findings: CodeReviewFinding[], inlineCount = 0): string {
  const lines = [
    "## Manso Code Review", "",
    `**Pull request:** [${pack.pullRequest.title}](${pack.pullRequest.url})`, "",
    `**Recommendation:** ${pack.review.approvalRecommendation}`, "",
    ...(pack.detectedTicketKey ? [`**Ticket:** ${pack.detectedTicketKey}`, ""] : []),
    "### Summary", "", pack.review.summary, "",
    "### Business Review", "", pack.review.businessImpact, "",
    "### Technical Review", "", pack.review.technicalAssessment, "",
    "### Findings", "",
  ];
  if (inlineCount > 0) lines.push(`${inlineCount} finding(s) posted inline on the PR diff. See those file/line threads for details.`, "");
  if (findings.length === 0) lines.push(inlineCount > 0 ? "No additional unlocated findings." : "No specific automated findings.", "");
  for (const finding of findings) {
    lines.push(`- **${finding.severity.toUpperCase()} ${finding.category}: ${finding.title}**`,
      `  ${finding.details}`, `  Recommendation: ${finding.recommendation}`,
      ...(finding.filePath ? [`  Location: \`${finding.filePath}${finding.line ? `:${finding.line} (${finding.side ?? "right"})` : ""}\``] : []),
      ...finding.evidence.map((evidence) => `  Evidence: ${evidence}`), "");
  }
  if (pack.review.questions.length) lines.push("### Questions", "", ...pack.review.questions.map((question) => `- ${question}`), "");
  if (pack.warnings.length) lines.push("### Limitations / Warnings", "", ...pack.warnings.map((warning) => `- ${warning}`), "");
  lines.push("_Automated advisory review, not a replacement for human approval._", "");
  return lines.join("\n");
}
