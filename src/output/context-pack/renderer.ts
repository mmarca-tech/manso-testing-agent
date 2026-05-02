import type { ContextPack } from "../../domain/contextPack/schema.js";

export function renderMarkdown(context: ContextPack): string {
  const lines: string[] = [];

  lines.push(`# ${context.ticket.key}: ${context.ticket.title}`, "");
  lines.push("## Ticket", "");
  lines.push(tableRows([
    ["Key", context.ticket.key],
    ["Title", context.ticket.title],
    ["Type", context.ticket.issueType],
    ["Status", context.ticket.status],
    ["Assignee", formatPerson(context.ticket.assignee)],
    ["Reporter", formatPerson(context.ticket.reporter)],
    ["Labels", context.ticket.labels.join(", ")],
    ["Components", context.ticket.components.join(", ")],
    ["URL", context.ticket.url],
  ]));

  lines.push("", "## Description", "", context.description.text || "_No description found._", "");

  lines.push("## Linked Issues", "");
  if (context.ticket.links.length === 0) {
    lines.push("_No linked issues found._", "");
  } else {
    for (const link of context.ticket.links) {
      lines.push(
        `- ${link.issueKey ?? "Unknown issue"}${link.title ? `: ${link.title}` : ""}${link.issueType ? ` (${link.issueType})` : ""}${link.status ? ` - ${link.status}` : ""}${link.relationship ? ` [${link.relationship}]` : ""}${link.url ? ` - ${link.url}` : ""}`,
      );
    }
    lines.push("");
  }

  lines.push("## Xray Test Cases", "");
  if (context.xrayTestCases.length === 0) {
    lines.push("_No linked Xray Test issues found._", "");
  } else {
    for (const test of context.xrayTestCases) {
      lines.push(`### ${test.key}: ${test.title}`, "");
      lines.push(tableRows([
        ["Status", test.status],
        ["Relationship", test.relationship],
        ["Labels", test.labels.join(", ")],
        ["URL", test.url],
      ]));
      if (test.description) {
        lines.push("", test.description, "");
      }
    }
  }

  lines.push("## Development", "");
  lines.push("### Branches", "");
  if (context.development.branches.length === 0) {
    lines.push("_No linked branches found._", "");
  } else {
    for (const branch of context.development.branches) {
      lines.push(
        `- ${branch.name}${branch.repository ? ` in ${branch.repository}` : ""}${branch.provider ? ` (${branch.provider})` : ""}${branch.lastUpdatedAt ? ` - updated ${branch.lastUpdatedAt}` : ""}${branch.url ? ` - ${branch.url}` : ""}`,
      );
    }
    lines.push("");
  }

  lines.push("### Pull Requests", "");
  if (context.development.pullRequests.length === 0) {
    lines.push("_No linked pull requests found._", "");
  } else {
    for (const pr of context.development.pullRequests) {
      lines.push(
        `- ${pr.title}${pr.status ? ` - ${pr.status}` : ""}${pr.repository ? ` in ${pr.repository}` : ""}${pr.sourceBranch || pr.targetBranch ? ` [${pr.sourceBranch ?? "?"} -> ${pr.targetBranch ?? "?"}]` : ""}${pr.author ? ` by ${formatPerson(pr.author)}` : ""}${pr.lastUpdatedAt ? ` - updated ${pr.lastUpdatedAt}` : ""}${pr.url ? ` - ${pr.url}` : ""}`,
      );
    }
    lines.push("");
  }

  lines.push("## Comments", "");
  if (context.comments.length === 0) {
    lines.push("_No comments found._", "");
  } else {
    for (const comment of context.comments) {
      lines.push(`### ${comment.createdAt ?? "Unknown date"}${comment.author ? ` - ${formatPerson(comment.author)}` : ""}`, "");
      if (comment.visibility) {
        lines.push(`Visibility: ${comment.visibility}`, "");
      }
      lines.push(comment.body, "");
    }
  }

  lines.push("## Attachments", "");
  if (context.attachments.length === 0) {
    lines.push("_No attachments found._", "");
  } else {
    for (const attachment of context.attachments) {
      lines.push(
        `- ${attachment.filename}${attachment.mimeType ? ` (${attachment.mimeType})` : ""}${attachment.sizeBytes !== undefined ? ` - ${attachment.sizeBytes} bytes` : ""}${attachment.url ? ` - ${attachment.url}` : ""}`,
      );
    }
    lines.push("");
  }

  lines.push("## Confluence Pages", "");
  if (context.confluencePages.length === 0) {
    lines.push("_No linked Confluence pages found._", "");
  } else {
    for (const page of context.confluencePages) {
      lines.push(`### ${page.title}`, "");
      lines.push(tableRows([
        ["Space", page.space],
        ["Updated", page.updatedAt],
        ["URL", page.url],
      ]));
      if (page.body) {
        lines.push("", page.body, "");
      }
    }
  }

  lines.push("## Warnings", "");
  if (context.warnings.length === 0) {
    lines.push("_No warnings._", "");
  } else {
    for (const warning of context.warnings) {
      lines.push(`- ${warning.section}${warning.toolName ? `/${warning.toolName}` : ""}: ${warning.message}`);
    }
    lines.push("");
  }

  lines.push("## Provenance", "");
  lines.push(`Generated: ${context.provenance.generatedAt}`, "");
  if (context.provenance.tools.length === 0) {
    lines.push("_No source calls were recorded._", "");
  } else {
    for (const tool of context.provenance.tools) {
      lines.push(
        `- ${tool.calledAt} ${tool.method} via ${tool.toolName}: ${tool.success ? "success" : `failed (${tool.message ?? "unknown error"})`}`,
      );
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

function formatPerson(person: ContextPack["ticket"]["assignee"]): string | undefined {
  if (!person) {
    return undefined;
  }

  return [person.name, person.email, person.accountId].filter(Boolean).join(" / ");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}
