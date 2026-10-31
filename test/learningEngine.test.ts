import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyLearning } from "../src/agents/learningEngine/classify.js";
import {
  buildGuidelineEdits,
  captureLearnings,
  hasProposals,
} from "../src/agents/learningEngine/index.js";
import { applyGuidelineEdits, proposeLearningsPr } from "../src/agents/learningEngine/proposer.js";
import { LearningRecordSetSchema } from "../src/domain/learningRecord/schema.js";
import { writeLearningRecordSet } from "../src/output/learning/writer.js";
import type { VcsAdapter, VcsRaisePullRequestInput, VcsRaisePullRequestResult } from "../src/integrations/vcs/adapter.js";

const fixedNow = () => new Date("2026-01-01T00:00:00.000Z");

describe("classifyLearning", () => {
  it("marks flaky/infra signals transient", () => {
    expect(classifyLearning("this test is flaky, passed on retry").classification).toBe("transient");
    expect(classifyLearning("failed due to a network timeout (503)").classification).toBe("transient");
  });

  it("marks selector/timing/data/convention signals systemic with a category", () => {
    expect(classifyLearning("use getByRole instead of this css selector")).toMatchObject({
      classification: "systemic",
      category: "selector",
    });
    expect(classifyLearning("never use Thread.Sleep; wait for state").category).toBe("timing");
    expect(classifyLearning("don't hardcode the tenant id, use a factory").category).toBe("test-data");
    expect(classifyLearning("always prefer data-testid as a convention").classification).toBe("systemic");
  });

  it("returns unknown when nothing matches", () => {
    expect(classifyLearning("ship it").classification).toBe("unknown");
    expect(classifyLearning("   ").classification).toBe("unknown");
  });
});

describe("captureLearnings", () => {
  it("classifies signals and attaches proposed changes to systemic ones", () => {
    const set = captureLearnings({
      issueKey: "QATG-1",
      now: fixedNow,
      signals: [
        { source: "pr-feedback", text: "use getByRole for the login button, not a css selector", pullRequestId: 7 },
        { source: "heal-failure", text: "flaky timeout on CI, passed on retry" },
      ],
    });

    expect(() => LearningRecordSetSchema.parse(set)).not.toThrow();
    expect(set.records).toHaveLength(2);
    const systemic = set.records.find((r) => r.classification === "systemic");
    expect(systemic?.category).toBe("selector");
    expect(systemic?.proposedChange?.targetPath).toBe(".agents/guidelines/selectors.md");
    expect(systemic?.pullRequestId).toBe(7);
    const transient = set.records.find((r) => r.classification === "transient");
    expect(transient?.proposedChange).toBeUndefined();
  });

  it("drops empty signals", () => {
    const set = captureLearnings({ signals: [{ source: "manual", text: "  " }], now: fixedNow });
    expect(set.records).toHaveLength(0);
  });
});

describe("buildGuidelineEdits", () => {
  it("groups systemic learnings by target file and dedups", () => {
    const set = captureLearnings({
      now: fixedNow,
      signals: [
        { source: "pr-feedback", text: "use getByRole, not css selectors" },
        { source: "pr-feedback", text: "prefer data-testid selectors" },
        { source: "pr-feedback", text: "never use Thread.Sleep" },
      ],
    });
    const edits = buildGuidelineEdits(set);
    const paths = edits.map((e) => e.path).sort();
    expect(paths).toEqual([".agents/guidelines/selectors.md", ".agents/guidelines/waiting.md"]);
    const selectors = edits.find((e) => e.path === ".agents/guidelines/selectors.md");
    expect(selectors?.additions).toHaveLength(2);
    expect(hasProposals(set)).toBe(true);
  });

  it("produces no edits when there are no systemic learnings", () => {
    const set = captureLearnings({ signals: [{ source: "manual", text: "flaky, retried" }], now: fixedNow });
    expect(buildGuidelineEdits(set)).toEqual([]);
    expect(hasProposals(set)).toBe(false);
  });
});

describe("applyGuidelineEdits", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "manso-learn-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("creates a new guideline file with a heading + provenance note", async () => {
    const set = captureLearnings({ now: fixedNow, signals: [{ source: "pr-feedback", text: "use getByRole, not css" }] });
    const touched = await applyGuidelineEdits(repo, buildGuidelineEdits(set));
    expect(touched).toEqual([".agents/guidelines/selectors.md"]);
    const content = await readFile(join(repo, ".agents/guidelines/selectors.md"), "utf8");
    expect(content).toContain("# Selector guidelines");
    expect(content).toContain("Review before merging");
    expect(content).toContain("- use getByRole, not css");
  });

  it("appends to an existing file and is idempotent", async () => {
    await mkdir(join(repo, ".agents/guidelines"), { recursive: true });
    await writeFile(join(repo, ".agents/guidelines/selectors.md"), "# Selector guidelines\n\n- existing rule\n", "utf8");
    const set = captureLearnings({ now: fixedNow, signals: [{ source: "pr-feedback", text: "use getByRole, not css" }] });

    await applyGuidelineEdits(repo, buildGuidelineEdits(set));
    const afterFirst = await readFile(join(repo, ".agents/guidelines/selectors.md"), "utf8");
    expect(afterFirst).toContain("- existing rule");
    expect(afterFirst).toContain("- use getByRole, not css");

    // Re-applying the same edit changes nothing.
    const touched = await applyGuidelineEdits(repo, buildGuidelineEdits(set));
    expect(touched).toEqual([]);
  });
});

describe("proposeLearningsPr", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "manso-propose-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  function fakeAdapter(raised: VcsRaisePullRequestInput[]): VcsAdapter {
    return {
      kind: "azure-devops",
      async raisePullRequest(input: VcsRaisePullRequestInput): Promise<VcsRaisePullRequestResult> {
        raised.push(input);
        return { status: "raised", url: "https://dev.azure.com/pr/1", pullRequestId: 1 };
      },
    };
  }

  it("skips when there is nothing systemic to propose", async () => {
    const set = captureLearnings({ signals: [{ source: "manual", text: "flaky, retried" }], now: fixedNow });
    const result = await proposeLearningsPr({ repoRoot: repo, set, adapter: fakeAdapter([]) });
    expect(result.status).toBe("skipped");
  });

  it("dry-run writes the guideline edits but raises no PR", async () => {
    const raised: VcsRaisePullRequestInput[] = [];
    const set = captureLearnings({ issueKey: "QATG-9", now: fixedNow, signals: [{ source: "pr-feedback", text: "use getByRole, not css" }] });
    const result = await proposeLearningsPr({ repoRoot: repo, set, adapter: fakeAdapter(raised), dryRun: true });
    expect(result.status).toBe("dry-run");
    expect(result.editedFiles).toContain(".agents/guidelines/selectors.md");
    expect(raised).toHaveLength(0);
    // The edit was written to disk even in dry-run (so a human can inspect it).
    const content = await readFile(join(repo, ".agents/guidelines/selectors.md"), "utf8");
    expect(content).toContain("- use getByRole, not css");
  });
});

describe("writeLearningRecordSet", () => {
  let outDir: string;
  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "manso-learn-out-"));
  });
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("writes learnings.json + learnings.md", async () => {
    const set = captureLearnings({ issueKey: "QATG-1", now: fixedNow, signals: [{ source: "pr-feedback", text: "use getByRole, not css" }] });
    const result = await writeLearningRecordSet(set, outDir);
    const json = JSON.parse(await readFile(result.jsonPath, "utf8"));
    expect(() => LearningRecordSetSchema.parse(json)).not.toThrow();
    const md = await readFile(result.markdownPath, "utf8");
    expect(md).toContain("# Learnings — QATG-1");
    expect(md).toContain("Systemic (proposed guideline edits)");
  });
});
