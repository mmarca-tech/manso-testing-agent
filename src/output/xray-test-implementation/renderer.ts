import type { XrayTestImplementationPack } from "../../domain/xrayTestImplementation/schema.js";

export function renderXrayTestImplementationMarkdown(pack: XrayTestImplementationPack): string {
  const lines: string[] = [];

  lines.push(`# Xray Test Implementation for ${pack.ticket.key}: ${pack.ticket.title}`, "");
  lines.push("## Summary", "");
  lines.push(tableRows([
    ["Status", pack.implementation.status],
    ["Branch", pack.implementation.branch],
    ["Target Branch", pack.implementation.targetBranch],
    ["Prompt", pack.implementation.promptPath],
    ["Commit", pack.implementation.commitSha],
    ["Pushed", pack.implementation.pushed ? "yes" : "no"],
    ["Pull Request", pack.pullRequest.url ?? pack.pullRequest.status],
  ]));

  lines.push("", "## Guidance Files", "");
  if (pack.implementation.guidanceFiles.length === 0) {
    lines.push("_No guidance files loaded._");
  } else {
    for (const file of pack.implementation.guidanceFiles) {
      lines.push(`- ${file.path} (${file.bytes} bytes)`);
    }
  }

  lines.push("", "## Commands", "");
  if (pack.implementation.command) {
    lines.push(`- Implementation: ${formatCommand(pack.implementation.command)}`);
  } else {
    lines.push("- Implementation: not run");
  }
  if (pack.implementation.verification) {
    lines.push(`- Verification: ${formatCommand(pack.implementation.verification)}`);
  } else {
    lines.push("- Verification: not run");
  }
  if (pack.implementation.healingAttempts && pack.implementation.healingAttempts.length > 0) {
    for (const attempt of pack.implementation.healingAttempts) {
      lines.push(`- Healing attempt ${attempt.attempt}: ${formatCommand(attempt.command)}`);
      lines.push(`- Healing verification ${attempt.attempt}: ${formatCommand(attempt.verification)}`);
      lines.push(`  Prompt: ${attempt.promptPath}`);
    }
  }

  lines.push("", "## Changed Files", "");
  if (pack.implementation.changedFiles.length === 0) {
    lines.push("_No changed files recorded._");
  } else {
    for (const file of pack.implementation.changedFiles) {
      lines.push(`- ${file}`);
    }
  }

  lines.push("", "## Pull Request", "");
  lines.push(tableRows([
    ["Status", pack.pullRequest.status],
    ["Provider", pack.pullRequest.provider],
    ["ID", pack.pullRequest.id?.toString()],
    ["URL", pack.pullRequest.url],
    ["Title", pack.pullRequest.title],
    ["Source Branch", pack.pullRequest.sourceBranch],
    ["Target Branch", pack.pullRequest.targetBranch],
  ]));
  for (const warning of pack.pullRequest.warnings) {
    lines.push(`- Warning: ${warning}`);
  }

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
  lines.push(`Source Xray generation: ${pack.provenance.sourceXrayTestGenerationPath}`, "");
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

function formatCommand(command: XrayTestImplementationPack["implementation"]["command"]): string {
  if (!command) {
    return "not run";
  }

  const usage = command.usage ? `, ${formatUsage(command.usage)}` : "";
  return `${command.command} (exit ${command.exitCode}, ${command.durationMs} ms${usage})`;
}

function formatUsage(usage: NonNullable<NonNullable<XrayTestImplementationPack["implementation"]["command"]>["usage"]>): string {
  const parts = [
    usage.provider,
    usage.model,
    usage.inputTokens !== undefined ? `prompt ${usage.inputTokens}` : undefined,
    usage.cachedInputTokens !== undefined ? `cached ${usage.cachedInputTokens}` : undefined,
    usage.cacheCreationInputTokens !== undefined ? `cache-write ${usage.cacheCreationInputTokens}` : undefined,
    usage.outputTokens !== undefined ? `completion ${usage.outputTokens}` : undefined,
    usage.reasoningOutputTokens !== undefined ? `reasoning ${usage.reasoningOutputTokens}` : undefined,
    usage.totalCostUsd !== undefined ? `$${usage.totalCostUsd.toFixed(6)}` : undefined,
  ].filter((part): part is string => part !== undefined);

  return parts.join(", ");
}
