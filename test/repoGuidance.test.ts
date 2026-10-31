import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRepoGuidance } from "../src/context/repoGuidance.js";
import { buildCritiquePrompt, buildGherkinDesignPrompt, SCENARIO_CONTRACTS } from "../src/agents/testArchitect/prompts.js";
import type { ContextPack } from "../src/domain/contextPack/schema.js";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "manso-guidance-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("loadRepoGuidance (M25)", () => {
  it("loads AGENTS.md, .agents docs, AND .agents/guidelines/*.md (sorted)", async () => {
    await writeFile(join(repo, "AGENTS.md"), "# Agent guide", "utf8");
    await mkdir(join(repo, ".agents", "guidelines"), { recursive: true });
    await writeFile(join(repo, ".agents", "test-architecture.md"), "arch", "utf8");
    await writeFile(join(repo, ".agents", "guidelines", "selectors.md"), "Prefer data-test ids.", "utf8");
    await writeFile(join(repo, ".agents", "guidelines", "pagination.md"), "Always boundary-test pagination.", "utf8");

    const result = await loadRepoGuidance(repo);
    expect(result.files.map((f) => f.path.replace(/\\/g, "/"))).toEqual([
      "AGENTS.md",
      ".agents/test-architecture.md",
      ".agents/guidelines/pagination.md",
      ".agents/guidelines/selectors.md",
    ]);
    expect(result.files[2]?.content).toContain("boundary-test pagination");
    expect(result.warnings).toEqual([]);
  });

  it("returns empty for a repo with no guidance", async () => {
    const result = await loadRepoGuidance(repo);
    expect(result.files).toEqual([]);
  });

  it("clips per file and stops at the total budget with warnings (no silent truncation)", async () => {
    await mkdir(join(repo, ".agents", "guidelines"), { recursive: true });
    await writeFile(join(repo, ".agents", "guidelines", "a.md"), "x".repeat(50), "utf8");
    await writeFile(join(repo, ".agents", "guidelines", "b.md"), "y".repeat(50), "utf8");
    await writeFile(join(repo, ".agents", "guidelines", "c.md"), "z".repeat(50), "utf8");

    const result = await loadRepoGuidance(repo, { maxFileChars: 30, maxTotalChars: 70 });
    expect(result.files).toHaveLength(2); // c.md omitted by the total budget
    expect(result.files[0]?.content).toContain("...(truncated)");
    expect(result.warnings.some((w) => w.includes("clipped"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("omitted") && w.includes("c.md"))).toBe(true);
  });

  it("skips empty files", async () => {
    await writeFile(join(repo, "AGENTS.md"), "   \n", "utf8");
    const result = await loadRepoGuidance(repo);
    expect(result.files).toEqual([]);
  });
});

describe("design prompts include the guidance section (M25)", () => {
  const context: ContextPack = {
    schemaVersion: "1.0.0",
    ticket: { key: "X-1", title: "T", labels: [], components: [], links: [] },
    description: { format: "markdown", text: "A feature." },
    comments: [],
    attachments: [],
    xrayTestCases: [],
    development: { branches: [], pullRequests: [] },
    confluencePages: [],
    provenance: { generatedAt: "2026-01-01T00:00:00.000Z", issueKey: "X-1", source: "jira-rest", tools: [] },
    warnings: [],
  };
  const guidance = [{ path: ".agents/guidelines/pagination.md", content: "Always boundary-test pagination." }];

  it("gherkin author sees team conventions & learned rules", () => {
    const { userPrompt } = buildGherkinDesignPrompt({
      context, acceptanceCriteria: [], skillBody: "skill", guidance,
    });
    expect(userPrompt).toContain("# Team conventions & learned rules");
    expect(userPrompt).toContain(".agents/guidelines/pagination.md");
    expect(userPrompt).toContain("Always boundary-test pagination.");
  });

  it("critique pass sees them too; absent guidance renders nothing", () => {
    const withGuidance = buildCritiquePrompt({
      context, acceptanceCriteria: [], skillBody: "skill", guidance,
      scenarioContract: SCENARIO_CONTRACTS.gherkin, draftedTitles: ["t1"],
    });
    expect(withGuidance.userPrompt).toContain("# Team conventions & learned rules");

    const without = buildGherkinDesignPrompt({ context, acceptanceCriteria: [], skillBody: "skill" });
    expect(without.userPrompt).not.toContain("Team conventions & learned rules");
  });
});
