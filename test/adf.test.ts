import { describe, expect, it } from "vitest";
import { adfToMarkdown, extractAdfLinks, isAdfDoc } from "../src/shared/adf.js";

/** A doc node helper. */
function doc(...content: unknown[]): unknown {
  return { type: "doc", version: 1, content };
}

function text(value: string, marks?: unknown[]): unknown {
  return marks ? { type: "text", text: value, marks } : { type: "text", text: value };
}

function paragraph(...content: unknown[]): unknown {
  return { type: "paragraph", content };
}

describe("isAdfDoc", () => {
  it("recognises doc nodes and node arrays, rejects plain values", () => {
    expect(isAdfDoc({ type: "doc", content: [] })).toBe(true);
    expect(isAdfDoc({ content: [] })).toBe(true);
    expect(isAdfDoc("a string")).toBe(false);
    expect(isAdfDoc(42)).toBe(false);
    expect(isAdfDoc(null)).toBe(false);
  });
});

describe("adfToMarkdown — block structure", () => {
  it("renders headings with the right level", () => {
    const md = adfToMarkdown(
      doc({ type: "heading", attrs: { level: 2 }, content: [text("Acceptance Criteria")] }),
    );
    expect(md).toBe("## Acceptance Criteria");
  });

  it("renders bullet and ordered lists with markers", () => {
    const bullet = adfToMarkdown(
      doc({
        type: "bulletList",
        content: [
          { type: "listItem", content: [paragraph(text("first"))] },
          { type: "listItem", content: [paragraph(text("second"))] },
        ],
      }),
    );
    expect(bullet).toBe("- first\n- second");

    const ordered = adfToMarkdown(
      doc({
        type: "orderedList",
        attrs: { order: 1 },
        content: [
          { type: "listItem", content: [paragraph(text("one"))] },
          { type: "listItem", content: [paragraph(text("two"))] },
        ],
      }),
    );
    expect(ordered).toBe("1. one\n2. two");
  });

  it("renders a table as a Markdown pipe table with a header separator", () => {
    const md = adfToMarkdown(
      doc({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [paragraph(text("Input"))] },
              { type: "tableHeader", content: [paragraph(text("Expected"))] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [paragraph(text("eligible order"))] },
              { type: "tableCell", content: [paragraph(text("plan shown"))] },
            ],
          },
        ],
      }),
    );
    expect(md).toBe(
      ["| Input | Expected |", "| --- | --- |", "| eligible order | plan shown |"].join("\n"),
    );
  });

  it("renders an info panel as a labelled blockquote", () => {
    const md = adfToMarkdown(
      doc({
        type: "panel",
        attrs: { panelType: "warning" },
        content: [paragraph(text("Ineligible orders must never show the plan."))],
      }),
    );
    expect(md).toBe("> **Panel (warning):**\n> Ineligible orders must never show the plan.");
  });

  it("renders a code block with its language fence", () => {
    const md = adfToMarkdown(
      doc({
        type: "codeBlock",
        attrs: { language: "json" },
        content: [text('{ "eligible": true }')],
      }),
    );
    expect(md).toBe('```json\n{ "eligible": true }\n```');
  });

  it("renders task lists as Markdown checkboxes", () => {
    const md = adfToMarkdown(
      doc({
        type: "taskList",
        content: [
          { type: "taskItem", attrs: { state: "DONE" }, content: [text("done item")] },
          { type: "taskItem", attrs: { state: "TODO" }, content: [text("todo item")] },
        ],
      }),
    );
    expect(md).toBe("- [x] done item\n- [ ] todo item");
  });
});

describe("adfToMarkdown — inline marks", () => {
  it("preserves bold, italic, code, and links", () => {
    const md = adfToMarkdown(
      doc(
        paragraph(
          text("The "),
          text("customer", [{ type: "strong" }]),
          text(" can "),
          text("select", [{ type: "em" }]),
          text(" the "),
          text("plan", [{ type: "code" }]),
          text(" — see "),
          text("the spec", [{ type: "link", attrs: { href: "https://example.com/spec" } }]),
          text("."),
        ),
      ),
    );
    expect(md).toBe(
      "The **customer** can *select* the `plan` — see [the spec](https://example.com/spec).",
    );
  });

  it("renders mentions and inline smart-cards", () => {
    const md = adfToMarkdown(
      doc(
        paragraph(
          { type: "mention", attrs: { text: "@Jane" } },
          text(" review "),
          { type: "inlineCard", attrs: { url: "https://example.com/ticket" } },
        ),
      ),
    );
    expect(md).toContain("@Jane");
    expect(md).toContain("[https://example.com/ticket](https://example.com/ticket)");
  });
});

describe("extractAdfLinks", () => {
  it("collects link marks and smart-cards, de-duplicated", () => {
    const links = extractAdfLinks(
      doc(
        paragraph(
          text("docs", [{ type: "link", attrs: { href: "https://example.com/a" } }]),
          text("docs again", [{ type: "link", attrs: { href: "https://example.com/a" } }]),
        ),
        paragraph({ type: "inlineCard", attrs: { url: "https://example.com/b" } }),
      ),
    );
    expect(links).toEqual([
      { text: "docs", url: "https://example.com/a" },
      { text: "docs again", url: "https://example.com/a" },
      { text: "https://example.com/b", url: "https://example.com/b" },
    ]);
  });

  it("returns an empty array when there are no links", () => {
    expect(extractAdfLinks(doc(paragraph(text("plain text"))))).toEqual([]);
  });
});
