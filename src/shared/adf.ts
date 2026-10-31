/**
 * Atlassian Document Format (ADF) → Markdown.
 *
 * Jira and Confluence return rich bodies as ADF JSON. The old extractor
 * flattened ADF into a space-joined text soup, losing tables, panels, links,
 * list markers, headings, and code fences — exactly the structure where
 * acceptance criteria tend to live. This converter preserves that structure as
 * Markdown so downstream LLM passes (AC extraction, Gherkin authoring) see the
 * requirement the way a human reads it in Jira.
 *
 * Pure and dependency-free: it only walks the ADF node shape, so it lives in
 * the shared (leaf) layer and is trivially unit-testable with fixtures.
 */

export interface AdfLink {
  /** Visible link text (falls back to the URL when ADF has no text). */
  text: string;
  /** Target URL. */
  url: string;
}

type Node = Record<string, unknown>;

function isRec(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nodesOf(node: unknown): unknown[] {
  if (!isRec(node)) return [];
  return Array.isArray(node.content) ? node.content : [];
}

function getAttr(node: Node, key: string): unknown {
  return isRec(node.attrs) ? node.attrs[key] : undefined;
}

function numAttr(node: Node, key: string, fallback: number): number {
  const value = getAttr(node, key);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampLevel(value: unknown): number {
  const n = typeof value === "number" ? Math.trunc(value) : 1;
  return Math.min(6, Math.max(1, n));
}

/** True when the value looks like an ADF document (or node array). */
export function isAdfDoc(value: unknown): boolean {
  return isRec(value) && (value.type === "doc" || Array.isArray(value.content));
}

/** Convert an ADF document (or node) to Markdown. */
export function adfToMarkdown(doc: unknown): string {
  if (!isRec(doc)) return "";
  const top = doc.type === "doc" || Array.isArray(doc.content) ? nodesOf(doc) : [doc];
  return renderBlocks(top)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderBlocks(nodes: unknown[]): string {
  return nodes
    .map((node) => renderBlock(node))
    .filter((block) => block.trim().length > 0)
    .join("\n\n");
}

function renderBlock(node: unknown): string {
  if (!isRec(node)) return "";
  const type = str(node.type);
  const content = nodesOf(node);

  switch (type) {
    case "paragraph":
      return renderInline(content);
    case "heading":
      return `${"#".repeat(clampLevel(getAttr(node, "level")))} ${renderInline(content)}`.trim();
    case "bulletList":
      return renderList(content, () => "- ");
    case "orderedList": {
      let index = numAttr(node, "order", 1);
      return renderList(content, () => `${index++}. `);
    }
    case "listItem":
      return renderBlocks(content);
    case "blockquote":
      return prefixLines(renderBlocks(content), "> ");
    case "panel": {
      const kind = str(getAttr(node, "panelType")) || "info";
      return prefixLines(`**Panel (${kind}):**\n${renderBlocks(content)}`, "> ");
    }
    case "codeBlock": {
      const lang = str(getAttr(node, "language"));
      const code = content.map((child) => (isRec(child) ? str(child.text) : "")).join("");
      return "```" + lang + "\n" + code + "\n```";
    }
    case "rule":
      return "---";
    case "table":
      return renderTable(content);
    case "mediaSingle":
    case "mediaGroup": {
      const media: string[] = [];
      collectMedia(content, media);
      return media.join("\n");
    }
    case "taskList":
      return content
        .map(renderTaskItem)
        .filter((line) => line.length > 0)
        .join("\n");
    case "decisionList":
      return content
        .map((item) => `- ${renderInline(nodesOf(item))}`)
        .filter((line) => line.trim() !== "-")
        .join("\n");
    case "expand":
    case "nestedExpand": {
      const title = str(getAttr(node, "title"));
      return (title ? `**${title}**\n` : "") + renderBlocks(content);
    }
    default: {
      if (content.length > 0) {
        const inline = renderInline(content);
        return inline.trim().length > 0 ? inline : renderBlocks(content);
      }
      return str(node.text);
    }
  }
}

function renderList(items: unknown[], marker: () => string): string {
  const lines: string[] = [];
  for (const item of items) {
    if (!isRec(item)) continue;
    const inner = renderBlocks(nodesOf(item));
    const bullet = marker();
    const indent = " ".repeat(bullet.length);
    const itemLines = inner.split("\n");
    const first = itemLines.shift() ?? "";
    lines.push(`${bullet}${first}`);
    for (const line of itemLines) {
      lines.push(line.length > 0 ? `${indent}${line}` : line);
    }
  }
  return lines.join("\n");
}

function renderTable(rows: unknown[]): string {
  const matrix: string[][] = [];
  for (const row of rows) {
    if (!isRec(row) || str(row.type) !== "tableRow") continue;
    matrix.push(nodesOf(row).map((cell) => renderCell(cell)));
  }
  if (matrix.length === 0) return "";

  const width = Math.max(...matrix.map((cells) => cells.length));
  const pad = (cells: string[]): string[] => {
    const padded = [...cells];
    while (padded.length < width) padded.push("");
    return padded;
  };
  const toLine = (cells: string[]): string => `| ${cells.join(" | ")} |`;

  const header = pad(matrix[0] ?? []);
  const separator = new Array(width).fill("---");
  const body = matrix.slice(1).map(pad);

  return [toLine(header), toLine(separator), ...body.map(toLine)].join("\n");
}

function renderCell(cell: unknown): string {
  return renderBlocks(nodesOf(cell))
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function collectMedia(nodes: unknown[], out: string[]): void {
  for (const node of nodes) {
    if (!isRec(node)) continue;
    if (str(node.type) === "media") {
      const alt = str(getAttr(node, "alt"));
      const id = str(getAttr(node, "id"));
      const label = alt || id;
      out.push(`_[media${label ? `: ${label}` : ""}]_`);
    } else {
      collectMedia(nodesOf(node), out);
    }
  }
}

function renderTaskItem(item: unknown): string {
  if (!isRec(item)) return "";
  const box = str(getAttr(item, "state")) === "DONE" ? "[x]" : "[ ]";
  return `- ${box} ${renderInline(nodesOf(item))}`.trim();
}

function renderInline(nodes: unknown[]): string {
  return nodes.map(renderInlineNode).join("");
}

function renderInlineNode(node: unknown): string {
  if (!isRec(node)) return "";
  const type = str(node.type);

  switch (type) {
    case "text":
      return applyMarks(str(node.text), Array.isArray(node.marks) ? node.marks : []);
    case "hardBreak":
      return "\n";
    case "mention": {
      const name = str(getAttr(node, "text")).replace(/^@/, "");
      return name ? `@${name}` : "@mention";
    }
    case "emoji":
      return str(getAttr(node, "text")) || str(getAttr(node, "shortName"));
    case "inlineCard":
    case "blockCard": {
      const url = str(getAttr(node, "url"));
      return url ? `[${url}](${url})` : "";
    }
    case "date": {
      const ts = getAttr(node, "timestamp");
      const ms = typeof ts === "string" ? Number(ts) : typeof ts === "number" ? ts : NaN;
      return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
    }
    case "status":
      return `[${str(getAttr(node, "text"))}]`;
    default: {
      const inner = nodesOf(node);
      return inner.length > 0 ? renderInline(inner) : "";
    }
  }
}

function applyMarks(text: string, marks: unknown[]): string {
  if (text.trim().length === 0) return text;
  let out = text;
  const has = (markType: string): boolean => marks.some((mark) => isRec(mark) && mark.type === markType);

  if (has("code")) out = "`" + out + "`";
  if (has("strike")) out = `~~${out}~~`;
  if (has("em")) out = `*${out}*`;
  if (has("strong")) out = `**${out}**`;

  const link = marks.find((mark) => isRec(mark) && mark.type === "link");
  if (isRec(link)) {
    const href = str(getAttr(link, "href"));
    if (href) out = `[${out}](${href})`;
  }

  return out;
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : prefix.trimEnd()))
    .join("\n");
}

/**
 * Collect every link in an ADF document — both inline `link` marks and
 * inline/block smart-cards — de-duplicated by (text, url).
 */
export function extractAdfLinks(doc: unknown): AdfLink[] {
  const out: AdfLink[] = [];
  const seen = new Set<string>();

  const push = (text: string, url: string): void => {
    const key = `${text}|${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text: text.trim() || url, url });
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isRec(node)) return;

    if (str(node.type) === "text" && Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (isRec(mark) && mark.type === "link") {
          const href = str(getAttr(mark, "href"));
          if (href) push(str(node.text) || href, href);
        }
      }
    }

    const type = str(node.type);
    if (type === "inlineCard" || type === "blockCard") {
      const url = str(getAttr(node, "url"));
      if (url) push(url, url);
    }

    walk(node.content);
  };

  walk(doc);
  return out;
}
