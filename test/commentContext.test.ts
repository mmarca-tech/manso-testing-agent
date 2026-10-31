import { describe, expect, it } from "vitest";
import { buildAcExtractionPrompt } from "../src/agents/testArchitect/prompts.js";
import type { ContextPack } from "../src/domain/contextPack/schema.js";

function contextWithComment(body: string): ContextPack {
  return {
    schemaVersion: "1.0.0",
    ticket: { key: "MP-1", title: "Story", labels: [], components: [], links: [] },
    description: { format: "markdown", text: "A feature." },
    comments: [{ author: { name: "QA" }, createdAt: "2026-01-01", body }],
    attachments: [],
    xrayTestCases: [],
    development: { branches: [], pullRequests: [] },
    confluencePages: [],
    provenance: { generatedAt: "2026-01-01T00:00:00.000Z", issueKey: "MP-1", source: "jira-rest", tools: [] },
    warnings: [],
  };
}

describe("comment context in prompts (truncation fix)", () => {
  it("keeps a long QA scenario table well past the old 800-char cap", () => {
    // 18-row markdown table, ~ a few thousand chars, like a real QA scenario list.
    const rows = Array.from({ length: 18 }, (_, i) => `| Scenario ${i + 1}: verify behaviour number ${i + 1} works end to end | open | ref-${i + 1} |`);
    const table = ["| Scenarios | Status | References |", "| --- | --- | --- |", ...rows].join("\n");
    expect(table.length).toBeGreaterThan(800);

    const { userPrompt } = buildAcExtractionPrompt({ context: contextWithComment(table), skillBody: "skill" });

    // The last rows (which the old 800-char cap clipped) must be present now.
    expect(userPrompt).toContain("Scenario 18: verify behaviour number 18");
    expect(userPrompt).not.toContain("…[truncated]");
  });

  it("bounds the total comment budget so a pathological comment can't explode the prompt", () => {
    const huge = "x".repeat(50000);
    const { userPrompt } = buildAcExtractionPrompt({ context: contextWithComment(huge), skillBody: "skill" });
    // The single comment is capped well below its 50k length (per-comment cap 8000).
    const xRun = userPrompt.match(/x+/)?.[0]?.length ?? 0;
    expect(xRun).toBeLessThanOrEqual(8000);
    expect(xRun).toBeGreaterThan(800);
  });
});
