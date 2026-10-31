import { describe, expect, it } from "vitest";
import { scoreTestDesign } from "../src/eval/scorer.js";
import { analyzeVariance, renderEvalReport, runEval } from "../src/eval/harness.js";
import type { GherkinScenario, TestDesignPack } from "../src/domain/testDesignPack/schema.js";

function scenario(overrides: Partial<GherkinScenario> = {}): GherkinScenario {
  return {
    kind: "gherkin",
    title: "Customer checks out successfully",
    feature: "Checkout",
    tags: ["@checkout"],
    acIds: ["AC-1"],
    risk: "medium",
    readiness: "ready",
    objective: "Verify checkout completes.",
    preconditions: [],
    steps: [
      { keyword: "Given", text: "a signed-in customer" },
      { keyword: "When", text: "they pay" },
      { keyword: "Then", text: "the order is confirmed" },
    ],
    sourceEvidence: [{ source: "description", reference: "p1", summary: "x" }],
    openQuestions: [],
    rationale: "y",
    ...overrides,
  };
}

function pack(overrides: Partial<TestDesignPack> = {}): TestDesignPack {
  return {
    schemaVersion: "1.0.0",
    ticket: { key: "QATG-1", title: "Checkout" },
    outputMode: "gherkin",
    acceptanceCriteria: [{ id: "AC-1", text: "Customer can check out." }],
    strategySummary: "Cover the happy path.",
    coverageGaps: [],
    scenarios: [scenario()],
    acCoverageMatrix: [{ acId: "AC-1", scenarioIndexes: [0] }],
    riskRanking: [{ level: "medium", scenarioIndexes: [0] }],
    openQuestions: [],
    provenance: { generatedAt: "2024-01-01T00:00:00.000Z", issueKey: "QATG-1", llm: { provider: "anthropic", model: "x" }, tools: [] },
    warnings: [],
    ...overrides,
  };
}

describe("scoreTestDesign", () => {
  it("gives a clean pack a perfect score", () => {
    const result = scoreTestDesign(pack());
    expect(result.score).toBe(100);
    expect(result.failures).toEqual([]);
  });

  it("penalises uncovered ACs", () => {
    const result = scoreTestDesign(
      pack({
        acceptanceCriteria: [{ id: "AC-1", text: "a" }, { id: "AC-2", text: "b" }],
        acCoverageMatrix: [{ acId: "AC-1", scenarioIndexes: [0] }, { acId: "AC-2", scenarioIndexes: [] }],
      }),
    );
    expect(result.score).toBeLessThan(100);
    expect(result.failures).toContain("ac-coverage");
  });

  it("accepts an AC covered by an existing test", () => {
    const result = scoreTestDesign(
      pack({
        acceptanceCriteria: [{ id: "AC-1", text: "a" }, { id: "AC-2", text: "b" }],
        acCoverageMatrix: [{ acId: "AC-1", scenarioIndexes: [0] }, { acId: "AC-2", scenarioIndexes: [] }],
        acsCoveredByExisting: ["AC-2"],
      }),
    );
    expect(result.failures).not.toContain("ac-coverage");
  });

  it("flags banned tags but allows @smoke", () => {
    const bad = scoreTestDesign(pack({ scenarios: [scenario({ tags: ["@checkout", "@high", "@AC-1"] })] }));
    expect(bad.failures).toContain("tag-hygiene");
    const ok = scoreTestDesign(pack({ scenarios: [scenario({ tags: ["@checkout", "@smoke"] })] }));
    expect(ok.failures).not.toContain("tag-hygiene");
  });

  it("flags duplicate scenario titles and missing structure", () => {
    const dup = scoreTestDesign(pack({
      acCoverageMatrix: [{ acId: "AC-1", scenarioIndexes: [0, 1] }],
      scenarios: [scenario(), scenario()],
    }));
    expect(dup.failures).toContain("title-uniqueness");

    const noThen = scoreTestDesign(pack({ scenarios: [scenario({ steps: [{ keyword: "Given", text: "x" }] })] }));
    expect(noThen.failures).toContain("structure");
  });
});

describe("runEval (release gate)", () => {
  it("passes when mean clears the gate and no case is below the floor", () => {
    const report = runEval({ cases: [{ name: "checkout", pack: pack() }], gateThreshold: 80, caseFloor: 60 });
    expect(report.passed).toBe(true);
    expect(report.meanScore).toBe(100);
  });

  it("fails when a case is below the floor even if the mean is high", () => {
    const weak = pack({
      acceptanceCriteria: [{ id: "AC-1", text: "a" }, { id: "AC-2", text: "b" }, { id: "AC-3", text: "c" }],
      acCoverageMatrix: [{ acId: "AC-1", scenarioIndexes: [0] }, { acId: "AC-2", scenarioIndexes: [] }, { acId: "AC-3", scenarioIndexes: [] }],
      strategySummary: "",
      scenarios: [scenario({ acIds: [], steps: [{ keyword: "Given", text: "x" }] })],
    });
    const report = runEval({ cases: [{ name: "good", pack: pack() }, { name: "weak", pack: weak }], gateThreshold: 50, caseFloor: 60 });
    expect(report.belowFloor).toContain("weak");
    expect(report.passed).toBe(false);
  });

  it("renders a readable report", () => {
    const md = renderEvalReport(runEval({ cases: [{ name: "checkout", pack: pack() }] }));
    expect(md).toContain("# Eval report");
    expect(md).toContain("PASS");
    expect(md).toContain("checkout");
  });
});

describe("analyzeVariance", () => {
  it("reports zero spread for identical runs and stability", () => {
    const v = analyzeVariance([pack(), pack(), pack()]);
    expect(v.runs).toBe(3);
    expect(v.stdDev).toBe(0);
    expect(v.stable).toBe(true);
  });

  it("detects instability when scores diverge beyond the threshold", () => {
    const weak = pack({
      acceptanceCriteria: [{ id: "AC-1", text: "a" }, { id: "AC-2", text: "b" }],
      acCoverageMatrix: [{ acId: "AC-1", scenarioIndexes: [0] }, { acId: "AC-2", scenarioIndexes: [] }],
      strategySummary: "",
      scenarios: [scenario({ acIds: [], tags: ["@AC-1", "@high"], steps: [{ keyword: "Given", text: "x" }] })],
    });
    const v = analyzeVariance([pack(), weak], 5);
    expect(v.stable).toBe(false);
    expect(v.max).toBeGreaterThan(v.min);
  });
});

describe("runEval — reference recall gate (M23)", () => {
  const reference = {
    cases: [
      { title: "Customer checks out successfully" },
      { title: "Checkout fails when the card is declined" },
    ],
  };

  it("computes recall for a reference-carrying case and gates on it", () => {
    // Pack covers only 1 of the 2 reference cases → recall 50%.
    const report = runEval({ cases: [{ name: "c1", pack: pack(), reference }], minRecall: 60 });
    expect(report.cases[0]?.referenceMatch?.recall).toBe(0.5);
    expect(report.belowRecall).toEqual(["c1"]);
    expect(report.passed).toBe(false);
    // Same suite passes when the recall gate is at 50.
    expect(runEval({ cases: [{ name: "c1", pack: pack(), reference }], minRecall: 50 }).passed).toBe(true);
  });

  it("does not apply the recall gate to cases without a reference", () => {
    const report = runEval({ cases: [{ name: "c1", pack: pack() }], minRecall: 100 });
    expect(report.cases[0]?.referenceMatch).toBeUndefined();
    expect(report.belowRecall).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("renders recall and the missed reference cases", () => {
    const report = runEval({ cases: [{ name: "c1", pack: pack(), reference }], minRecall: 50 });
    const rendered = renderEvalReport(report);
    expect(rendered).toContain("50% (1/2)");
    expect(rendered).toContain("Missed reference cases — c1:");
    expect(rendered).toContain("Checkout fails when the card is declined");
  });
});
