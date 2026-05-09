import type { ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import type { AtlassianRestClient } from "./client.js";

export type JiraReleaseNotesFieldFormat = "auto" | "text" | "adf";

export interface JiraReleaseNotesUpdaterOptions {
  client: AtlassianRestClient;
  fieldId?: string;
  fieldFormat?: JiraReleaseNotesFieldFormat;
}

const DEFAULT_RELEASE_NOTES_FIELD_ID = "customfield_11101";

export class JiraReleaseNotesUpdater {
  private readonly client: AtlassianRestClient;
  private readonly fieldId: string;
  private readonly fieldFormat: JiraReleaseNotesFieldFormat;
  private readonly provenance: ToolProvenance[] = [];
  private readonly warnings: Warning[] = [];

  constructor(options: JiraReleaseNotesUpdaterOptions) {
    this.client = options.client;
    this.fieldId = options.fieldId ?? DEFAULT_RELEASE_NOTES_FIELD_ID;
    this.fieldFormat = options.fieldFormat ?? "auto";
  }

  async update(issueKey: string, markdown: string): Promise<void> {
    if (this.fieldFormat === "text") {
      await this.updateField(issueKey, markdown, "text");
      return;
    }

    if (this.fieldFormat === "adf") {
      await this.updateField(issueKey, markdownToAdf(markdown), "adf");
      return;
    }

    try {
      await this.updateField(issueKey, markdown, "text");
    } catch (textError) {
      this.warnings.push({
        section: "jiraUpload",
        toolName: "jira-rest:update-issue",
        message: `Plain text update failed for ${this.fieldId}; retrying with Atlassian Document Format. ${errorMessage(textError)}`,
      });
      await this.updateField(issueKey, markdownToAdf(markdown), "adf");
    }
  }

  getProvenance(): ToolProvenance[] {
    return [...this.provenance];
  }

  getWarnings(): Warning[] {
    return [...this.warnings];
  }

  private async updateField(issueKey: string, value: unknown, format: "text" | "adf"): Promise<void> {
    const calledAt = new Date().toISOString();

    try {
      await this.client.putJson("jira", `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
        fields: {
          [this.fieldId]: value,
        },
      });
      this.provenance.push({
        method: "updateReleaseNotesField",
        toolName: "jira-rest:update-issue",
        calledAt,
        success: true,
        message: `${this.fieldId} updated as ${format}.`,
      });
    } catch (error) {
      const message = errorMessage(error);
      this.provenance.push({
        method: "updateReleaseNotesField",
        toolName: "jira-rest:update-issue",
        calledAt,
        success: false,
        message: `${this.fieldId} ${format} update failed: ${message}`,
      });
      throw error;
    }
  }
}

function markdownToAdf(markdown: string): unknown {
  const content: unknown[] = [];
  const paragraphLines: string[] = [];
  let bulletItems: string[] = [];

  function flushParagraph(): void {
    const text = paragraphLines.join(" ").replace(/\s+/g, " ").trim();
    paragraphLines.length = 0;
    if (text.length > 0) {
      content.push(paragraph(stripMarkdown(text)));
    }
  }

  function flushBullets(): void {
    if (bulletItems.length === 0) {
      return;
    }

    content.push({
      type: "bulletList",
      content: bulletItems.map((item) => ({
        type: "listItem",
        content: [paragraph(stripMarkdown(item))],
      })),
    });
    bulletItems = [];
  }

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushBullets();
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const marker = headingMatch[1];
      const heading = headingMatch[2];
      if (!marker || !heading) {
        continue;
      }
      flushParagraph();
      flushBullets();
      content.push({
        type: "heading",
        attrs: { level: marker.length },
        content: textContent(stripMarkdown(heading)),
      });
      continue;
    }

    const bulletMatch = /^[-*]\s+(.+)$/.exec(line);
    if (bulletMatch) {
      const bullet = bulletMatch[1];
      if (!bullet) {
        continue;
      }
      flushParagraph();
      bulletItems.push(bullet);
      continue;
    }

    const tableText = tableRowToText(line);
    if (tableText === undefined) {
      paragraphLines.push(line);
      continue;
    }

    if (tableText.length > 0) {
      flushParagraph();
      flushBullets();
      content.push(paragraph(stripMarkdown(tableText)));
    }
  }

  flushParagraph();
  flushBullets();

  return {
    type: "doc",
    version: 1,
    content: content.length > 0 ? content : [paragraph("No release notes generated.")],
  };
}

function paragraph(value: string): unknown {
  return {
    type: "paragraph",
    content: textContent(value),
  };
}

function textContent(value: string): unknown[] {
  const text = value.trim();
  return text ? [{ type: "text", text }] : [];
}

function tableRowToText(line: string): string | undefined {
  if (!line.startsWith("|") || !line.endsWith("|")) {
    return undefined;
  }

  const cells = line
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());

  if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
    return "";
  }

  const firstCell = cells[0];
  const secondCell = cells[1];
  if (firstCell?.toLowerCase() === "field" && secondCell?.toLowerCase() === "value") {
    return "";
  }

  if (cells.length === 2 && firstCell && secondCell !== undefined && firstCell.toLowerCase() !== "field") {
    return `${firstCell}: ${secondCell}`;
  }

  return cells.join(" | ");
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/[*_`]/g, "")
    .replace(/<br>/gi, "\n")
    .trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
