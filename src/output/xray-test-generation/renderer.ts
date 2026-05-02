import type { XrayTestGenerationPack } from "../../domain/xrayTestGeneration/schema.js";

export function renderXrayTestGenerationMarkdown(pack: XrayTestGenerationPack): string {
  const lines: string[] = [];

  lines.push(`# Xray Test Generation for ${pack.ticket.key}: ${pack.ticket.title}`, "");
  lines.push("## Summary", "");
  lines.push(tableRows([
    ["Ticket", pack.ticket.key],
    ["LLM", `${pack.provenance.llm.provider} / ${pack.provenance.llm.model}`],
    ["Application", pack.application.status],
    ["Test Cases", String(pack.plan.testCases.length)],
    ["Test Set", pack.application.testSet.key ?? pack.application.testSet.status],
  ]));

  lines.push("", "## Strategy", "", pack.plan.strategySummary, "");
  lines.push("Coverage gaps:");
  pushList(lines, pack.plan.coverageGaps);

  lines.push("", "## Planned Test Cases", "");
  for (const testCase of pack.plan.testCases) {
    lines.push(`### ${testCase.title}`, "");
    lines.push(tableRows([
      ["Action", testCase.action],
      ["Existing Test", testCase.existingTestKey],
      ["Priority", testCase.priority],
      ["Risk Covered", testCase.riskCovered],
      ["Readiness", testCase.readiness],
      ["Coverage", testCase.coverageAreas.join(", ")],
    ]));
    lines.push("", `Objective: ${testCase.objective}`, "");
    lines.push("Preconditions:");
    pushList(lines, testCase.preconditions);
    lines.push("", "Steps:");
    if (testCase.steps.length === 0) {
      lines.push("_No steps supplied._");
    } else {
      testCase.steps.forEach((step, index) => {
        lines.push(`${index + 1}. ${step.action}`);
        if (step.data) {
          lines.push(`   Data: ${step.data}`);
        }
        lines.push(`   Expected: ${step.expectedResult}`);
      });
    }
    lines.push("", "Source evidence:");
    if (testCase.sourceEvidence.length === 0) {
      lines.push("_No source evidence supplied._");
    } else {
      for (const evidence of testCase.sourceEvidence) {
        lines.push(`- ${evidence.source}: ${evidence.reference} - ${evidence.summary}`);
      }
    }
    lines.push("", "Open questions:");
    pushList(lines, testCase.openQuestions);
    lines.push("", `Rationale: ${testCase.rationale}`, "");
  }

  lines.push("## Applied Results", "");
  lines.push("Test cases:");
  for (const test of pack.application.tests) {
    const key = test.key ?? test.existingTestKey ?? "unresolved";
    lines.push(`- ${test.status}: ${key} - ${test.requestedTitle}${test.linkedToTicket === undefined ? "" : ` (linked to ticket: ${test.linkedToTicket ? "yes" : "no"})`}`);
    for (const warning of test.warnings) {
      lines.push(`  Warning: ${warning}`);
    }
  }

  lines.push("", "Test set:", "");
  lines.push(tableRows([
    ["Status", pack.application.testSet.status],
    ["Key", pack.application.testSet.key],
    ["Issue ID", pack.application.testSet.issueId],
    ["Title", pack.application.testSet.title],
    ["Included Tests", pack.application.testSet.includedTestKeys.join(", ")],
  ]));

  lines.push("", "## Warnings", "");
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
  if (pack.provenance.sourceXrayTestReviewPath) {
    lines.push(`Source Xray test review: ${pack.provenance.sourceXrayTestReviewPath}`, "");
  }
  if (pack.provenance.sourcePrChangesPath) {
    lines.push(`Source PR changes: ${pack.provenance.sourcePrChangesPath}`, "");
  }
  if (pack.provenance.sourceConfluenceImpactPath) {
    lines.push(`Source Confluence impact: ${pack.provenance.sourceConfluenceImpactPath}`, "");
  }
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
