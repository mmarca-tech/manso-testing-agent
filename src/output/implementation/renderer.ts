import type { ImplementationPack } from "../../domain/implementationPack/schema.js";

/** Render an ImplementationPack as a human-readable Markdown report. */
export function renderImplementationMarkdown(pack: ImplementationPack): string {
  const lines: string[] = [];

  lines.push(`# Implementation — ${pack.ticket.key}: ${pack.ticket.title}`, "");
  lines.push(`Status: \`${pack.status}\`  ·  Stack: \`${pack.stack}\``);
  lines.push(`Repository: ${pack.repoRoot}`);
  if (pack.branch) lines.push(`Branch: ${pack.branch}`);
  lines.push("");

  lines.push("## Implementation agent", "");
  lines.push(formatCommand(pack.implementation));

  if (pack.verification) {
    lines.push("", "## Verification", "");
    lines.push(formatCommand(pack.verification));
  }

  if (pack.healingAttempts.length > 0) {
    lines.push("", "## Healing attempts", "");
    pack.healingAttempts.forEach((attempt) => {
      lines.push(`### Attempt ${attempt.attempt}`);
      lines.push("Agent:");
      lines.push(formatCommand(attempt.agent));
      lines.push("", "Verification:");
      lines.push(formatCommand(attempt.verification));
      lines.push("");
    });
  }

  lines.push("", "## Scenarios", "");
  if (pack.scenarios.length === 0) {
    lines.push("_No scenarios were targeted._");
  } else {
    for (const scenario of pack.scenarios) {
      const acs = scenario.acIds.length > 0 ? ` [${scenario.acIds.join(", ")}]` : "";
      const reason = scenario.reason ? ` — ${scenario.reason}` : "";
      lines.push(`- \`${scenario.status}\` #${scenario.scenarioIndex + 1}: ${scenario.title}${acs}${reason}`);
    }
  }

  lines.push("", "## Changed files", "");
  if (pack.changedFiles.length === 0) {
    lines.push("_No file changes were detected._");
  } else {
    for (const file of pack.changedFiles) {
      lines.push(`- ${file}`);
    }
  }

  if (pack.pullRequest) {
    lines.push("", "## Pull request", "");
    lines.push(`- Status: ${pack.pullRequest.status}`);
    lines.push(`- Branch: ${pack.pullRequest.branch} → ${pack.pullRequest.targetBranch}`);
    lines.push(`- URL: ${pack.pullRequest.url}`);
    if (pack.pullRequest.message) lines.push(`- Message: ${pack.pullRequest.message}`);
  }

  if (pack.warnings.length > 0) {
    lines.push("", "## Warnings", "");
    for (const warning of pack.warnings) {
      lines.push(`- ${warning.section}${warning.toolName ? `/${warning.toolName}` : ""}: ${warning.message}`);
    }
  }

  lines.push("", "## Provenance", "");
  lines.push(`Generated: ${pack.provenance.generatedAt}`);
  lines.push(`LLM: ${pack.provenance.llm.provider}${pack.provenance.llm.model ? `/${pack.provenance.llm.model}` : ""}`);
  if (pack.promptPath) lines.push(`Prompt: ${pack.promptPath}`);
  for (const tool of pack.provenance.tools) {
    lines.push(
      `- ${tool.calledAt} ${tool.method} via ${tool.toolName}: ${tool.success ? "success" : `failed (${tool.message ?? "unknown"})`}`,
    );
  }

  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
}

function formatCommand(result: ImplementationPack["implementation"]): string {
  const lines: string[] = [];
  lines.push(`- Command: \`${result.command}\``);
  lines.push(`- Exit: ${result.exitCode}  ·  Duration: ${result.durationMs} ms`);
  if (result.usage) {
    const usage = result.usage;
    const parts: string[] = [`provider=${usage.provider}`];
    if (usage.model) parts.push(`model=${usage.model}`);
    if (usage.inputTokens !== undefined) parts.push(`in=${usage.inputTokens}`);
    if (usage.outputTokens !== undefined) parts.push(`out=${usage.outputTokens}`);
    if (usage.totalCostUsd !== undefined) parts.push(`cost=$${usage.totalCostUsd.toFixed(4)}`);
    lines.push(`- Usage: ${parts.join(", ")}`);
  }
  if (result.stdout) {
    lines.push("", "Stdout (truncated):", "```text", truncate(result.stdout, 2000), "```");
  }
  if (result.stderr) {
    lines.push("", "Stderr (truncated):", "```text", truncate(result.stderr, 2000), "```");
  }
  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n[truncated]`;
}
