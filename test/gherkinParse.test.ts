import { describe, expect, it } from "vitest";
import {
  GherkinParseError,
  parseGherkinBody,
  parseGherkinScenario,
} from "../src/integrations/xray/gherkinParse.js";
import { renderScenarioGherkin } from "../src/integrations/xray/testDesignSink.js";
import { GherkinScenarioSchema, type GherkinScenario } from "../src/domain/testDesignPack/schema.js";

function scenario(overrides: Partial<GherkinScenario> = {}): GherkinScenario {
  return {
    kind: "gherkin",
    title: "User logs in with valid credentials",
    feature: "Authentication",
    tags: ["@auth", "@smoke"],
    acIds: ["AC-1"],
    risk: "high",
    readiness: "ready",
    objective: "Verify login.",
    preconditions: [],
    steps: [
      { keyword: "Given", text: "I am on the login page" },
      { keyword: "When", text: "I sign in" },
      { keyword: "Then", text: "I see the dashboard" },
    ],
    sourceEvidence: [],
    openQuestions: [],
    rationale: "Positive path.",
    ...overrides,
  };
}

describe("parseGherkinScenario (round-trip with renderScenarioGherkin)", () => {
  it("recovers title, tags, and steps", () => {
    const original = scenario();
    const parsed = parseGherkinScenario(renderScenarioGherkin(original), "fallback title");
    expect(parsed.title).toBe(original.title);
    expect(parsed.tags).toEqual(original.tags);
    expect(parsed.steps).toEqual(original.steps);
    expect(GherkinScenarioSchema.parse(parsed)).toBeTruthy();
  });

  it("uses the fallback title as the feature and synthesizes defaults", () => {
    const parsed = parseGherkinScenario(renderScenarioGherkin(scenario()), "My Xray Summary");
    expect(parsed.feature).toBe("My Xray Summary");
    expect(parsed.acIds).toEqual([]);
    expect(parsed.risk).toBe("medium");
    expect(parsed.readiness).toBe("ready");
    expect(parsed.sourceEvidence).toEqual([]);
    expect(parsed.rationale).toContain("Reconstructed");
  });

  it("round-trips a data table", () => {
    const original = scenario({
      steps: [
        { keyword: "Given", text: "I open the page" },
        {
          keyword: "Then",
          text: "the table shows the columns",
          dataTable: [["Actions"], ["Invoice ID"], ["Status"]],
        },
      ],
    });
    const parsed = parseGherkinScenario(renderScenarioGherkin(original), "fallback");
    expect(parsed.steps[1]?.dataTable).toEqual([["Actions"], ["Invoice ID"], ["Status"]]);
    expect(GherkinScenarioSchema.parse(parsed)).toBeTruthy();
  });

  it("round-trips a multi-cell data table", () => {
    const original = scenario({
      steps: [
        { keyword: "Then", text: "the grid shows", dataTable: [["a", "b"], ["c", "d"]] },
      ],
    });
    const parsed = parseGherkinScenario(renderScenarioGherkin(original), "fallback");
    expect(parsed.steps[0]?.dataTable).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("round-trips a Scenario Outline + Examples", () => {
    const original = scenario({
      examples: { headers: ["amount", "plan"], rows: [["30.00", "hidden"], ["300.00", "visible"]] },
    });
    const parsed = parseGherkinScenario(renderScenarioGherkin(original), "fallback");
    expect(parsed.examples).toEqual(original.examples);
    expect(GherkinScenarioSchema.parse(parsed)).toBeTruthy();
  });

  it("handles a scenario with no tags", () => {
    const parsed = parseGherkinScenario(renderScenarioGherkin(scenario({ tags: [] })), "fallback");
    expect(parsed.tags).toEqual([]);
  });
});

describe("parseGherkinBody errors", () => {
  it("throws on an empty string", () => {
    expect(() => parseGherkinBody("")).toThrow(GherkinParseError);
  });

  it("throws when there is a scenario line but no steps", () => {
    expect(() => parseGherkinBody("Scenario: lonely\n")).toThrow(GherkinParseError);
  });

  it("throws when there are steps but no Scenario line", () => {
    expect(() => parseGherkinBody("Given something\nThen something else\n")).toThrow(GherkinParseError);
  });

  it("downgrades a Scenario Outline with no Examples to a plain scenario", () => {
    const parsed = parseGherkinBody("Scenario Outline: x\n  Given a <thing>\n");
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.examples).toBeUndefined();
  });
});
