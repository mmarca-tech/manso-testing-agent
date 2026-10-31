import { describe, expect, it } from "vitest";
import { analyzeAttachments, classifyAttachment } from "../src/context/attachmentAnalysis.js";
import type { Attachment, Warning } from "../src/domain/contextPack/schema.js";
import type { AttachmentContent } from "../src/workflows/ticket-context/ticketSource.js";

function bytes(text: string): AttachmentContent {
  return { data: new TextEncoder().encode(text) };
}

describe("classifyAttachment", () => {
  it("classifies by MIME type", () => {
    expect(classifyAttachment({ filename: "a", mimeType: "text/plain" })).toBe("text");
    expect(classifyAttachment({ filename: "a", mimeType: "application/json" })).toBe("text");
    expect(classifyAttachment({ filename: "a", mimeType: "image/png" })).toBe("image");
    expect(classifyAttachment({ filename: "a", mimeType: "application/pdf" })).toBe("pdf");
    expect(classifyAttachment({ filename: "a", mimeType: "application/zip" })).toBe("other");
  });

  it("falls back to the filename extension", () => {
    expect(classifyAttachment({ filename: "spec.feature" })).toBe("text");
    expect(classifyAttachment({ filename: "contract.csv" })).toBe("text");
    expect(classifyAttachment({ filename: "mockup.PNG" })).toBe("image");
    expect(classifyAttachment({ filename: "design.pdf" })).toBe("pdf");
    expect(classifyAttachment({ filename: "archive.bin" })).toBe("other");
  });
});

describe("analyzeAttachments", () => {
  it("extracts UTF-8 text for text-like attachments", async () => {
    const warnings: Warning[] = [];
    const attachments: Attachment[] = [{ filename: "rules.txt", mimeType: "text/plain" }];
    const result = await analyzeAttachments({
      attachments,
      warnings,
      fetchContent: async () => bytes("Eligible orders over 100 EUR can pay in instalments."),
    });
    expect(result[0]?.analysis).toBe("Eligible orders over 100 EUR can pay in instalments.");
    expect(result[0]?.analysisSource).toBe("text-extraction");
    expect(warnings).toEqual([]);
  });

  it("visibly truncates long text", async () => {
    const warnings: Warning[] = [];
    const long = "x".repeat(50);
    const result = await analyzeAttachments({
      attachments: [{ filename: "big.txt" }],
      warnings,
      maxTextChars: 10,
      fetchContent: async () => bytes(long),
    });
    expect(result[0]?.analysis).toBe(`${"x".repeat(10)}…[truncated]`);
  });

  it("leaves image and pdf attachments unanalyzed (deferred to the vision pass)", async () => {
    const warnings: Warning[] = [];
    const result = await analyzeAttachments({
      attachments: [
        { filename: "mockup.png", mimeType: "image/png" },
        { filename: "spec.pdf", mimeType: "application/pdf" },
      ],
      warnings,
      fetchContent: async () => bytes("should not be used"),
    });
    expect(result[0]?.analysis).toBeUndefined();
    expect(result[1]?.analysis).toBeUndefined();
  });

  it("warns and returns attachments unchanged when no download capability exists", async () => {
    const warnings: Warning[] = [];
    const attachments: Attachment[] = [{ filename: "rules.txt", mimeType: "text/plain" }];
    const result = await analyzeAttachments({ attachments, warnings });
    expect(result[0]?.analysis).toBeUndefined();
    expect(warnings.some((w) => w.section === "attachments" && /cannot download/i.test(w.message))).toBe(true);
  });

  it("caps the number of analyzed text attachments and warns", async () => {
    const warnings: Warning[] = [];
    const attachments: Attachment[] = [
      { filename: "a.txt" },
      { filename: "b.txt" },
      { filename: "c.txt" },
    ];
    const result = await analyzeAttachments({
      attachments,
      warnings,
      maxAttachments: 2,
      fetchContent: async (a) => bytes(`content of ${a.filename}`),
    });
    const analyzedCount = result.filter((a) => a.analysis).length;
    expect(analyzedCount).toBe(2);
    expect(warnings.some((w) => w.section === "attachments" && /capped at 2/.test(w.message))).toBe(true);
  });

  it("records a warning and keeps the attachment when a download fails", async () => {
    const warnings: Warning[] = [];
    const result = await analyzeAttachments({
      attachments: [{ filename: "rules.txt" }],
      warnings,
      fetchContent: async () => {
        throw new Error("403 forbidden");
      },
    });
    expect(result[0]?.analysis).toBeUndefined();
    expect(warnings.some((w) => /rules\.txt.*403 forbidden/.test(w.message))).toBe(true);
  });
});
