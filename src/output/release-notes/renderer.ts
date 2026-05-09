import type { ReleaseNotesPack } from "../../domain/releaseNotes/schema.js";

export function renderReleaseNotesMarkdown(pack: ReleaseNotesPack): string {
  const lines: string[] = [];

  lines.push(`# ${pack.notes.title}`, "");
  lines.push(tableRows([
    ["Release Ticket", linkOrText(pack.releaseTicket.key, pack.releaseTicket.url)],
    ["Status", pack.releaseTicket.status],
    ["Audience", pack.notes.audience],
  ]));

  lines.push("", "## Summary", "", pack.notes.summary, "");

  lines.push("## Highlights", "");
  pushList(lines, pack.notes.highlights);

  lines.push("", "## Changes", "");
  if (pack.notes.changeItems.length === 0) {
    lines.push("_No release changes were generated._", "");
  } else {
    for (const item of pack.notes.changeItems) {
      lines.push(`### ${item.area}`, "");
      lines.push(item.description, "");
      lines.push(`Impact: ${item.impact}`, "");
    }
  }

  pushNamedList(lines, "Deployment Notes", pack.notes.deploymentNotes, 2);
  pushNamedList(lines, "Release Testing Notes", pack.notes.testingNotes, 2);
  pushNamedList(lines, "Known Risks", pack.notes.knownRisks, 2);

  if (pack.warnings.length > 0) {
    lines.push("## Generation Warnings", "");
    for (const warning of pack.warnings) {
      lines.push(`- ${warning.section}${warning.toolName ? `/${warning.toolName}` : ""}: ${warning.message}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
}

function pushNamedList(lines: string[], title: string, values: string[], headingLevel = 4): void {
  if (values.length === 0) {
    return;
  }

  lines.push(`${"#".repeat(headingLevel)} ${title}`, "");
  pushList(lines, values);
  lines.push("");
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

function linkOrText(label: string, url: string | undefined): string {
  return url ? `[${label}](${url})` : label;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}
