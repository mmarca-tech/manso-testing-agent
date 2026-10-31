import {
  GHERKIN_KEYWORDS,
  type GherkinExamples,
  type GherkinScenario,
  type GherkinStep,
} from "../../domain/testDesignPack/schema.js";

/** Thrown when a Gherkin string cannot be parsed into a valid scenario. */
export class GherkinParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GherkinParseError";
  }
}

export interface ParsedGherkin {
  title?: string;
  tags: string[];
  outline: boolean;
  steps: GherkinStep[];
  examples?: GherkinExamples;
}

const SCENARIO_RE = /^(Scenario Outline|Scenario):\s*(.+?)\s*$/;
const STEP_RE = /^(Given|When|Then|And|But)\s+(.+\S)\s*$/;
const TABLE_RE = /^\|(.*)\|$/;
const EXAMPLES_RE = /^Examples:/i;

const KEYWORDS = new Set<string>(GHERKIN_KEYWORDS);

/** Split a `| a | b |` table line into trimmed cells. */
function splitRow(inner: string): string[] {
  return inner.split("|").map((cell) => cell.trim());
}

/**
 * Parse a Gherkin scenario string — the inverse of `renderScenarioGherkin`.
 * Handles a leading tag line, `Scenario` / `Scenario Outline`, Given/When/Then
 * steps, step data tables (`    | a | b |`), and an `Examples:` block.
 *
 * Pure (no I/O). Throws {@link GherkinParseError} when there is no scenario
 * line or no steps. A `Scenario Outline` with no `Examples` is downgraded to a
 * plain scenario (its steps are kept).
 */
export function parseGherkinBody(gherkin: string): ParsedGherkin {
  const tags: string[] = [];
  let title: string | undefined;
  let outline = false;
  const steps: GherkinStep[] = [];
  // Data-table rows accumulated per step index (parallel to `steps`).
  const stepRows = new Map<number, string[][]>();
  let examplesHeaders: string[] | undefined;
  const examplesRows: string[][] = [];

  type Mode = "pre" | "steps" | "examples";
  let mode: Mode = "pre";

  for (const raw of gherkin.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    if (mode === "pre" && line.startsWith("@")) {
      for (const tag of line.split(/\s+/)) {
        if (tag.length > 0) tags.push(tag);
      }
      continue;
    }

    const scenarioMatch = SCENARIO_RE.exec(line);
    if (scenarioMatch) {
      outline = scenarioMatch[1] === "Scenario Outline";
      title = scenarioMatch[2];
      mode = "steps";
      continue;
    }

    if (EXAMPLES_RE.test(line)) {
      mode = "examples";
      continue;
    }

    const tableMatch = TABLE_RE.exec(line);
    if (tableMatch) {
      const cells = splitRow(tableMatch[1] ?? "");
      if (mode === "examples") {
        if (!examplesHeaders) {
          examplesHeaders = cells;
        } else {
          examplesRows.push(cells);
        }
      } else if (mode === "steps" && steps.length > 0) {
        const index = steps.length - 1;
        const rows = stepRows.get(index) ?? [];
        rows.push(cells);
        stepRows.set(index, rows);
      }
      continue;
    }

    const stepMatch = STEP_RE.exec(line);
    if (stepMatch && mode === "steps") {
      const keyword = stepMatch[1] as GherkinStep["keyword"];
      const text = stepMatch[2] ?? "";
      if (KEYWORDS.has(keyword) && text.length > 0) {
        steps.push({ keyword, text });
      }
      continue;
    }
    // Unrecognized line (Feature:, Background:, free text) — ignore.
  }

  if (title === undefined) {
    throw new GherkinParseError("No `Scenario:` or `Scenario Outline:` line found.");
  }
  if (steps.length === 0) {
    throw new GherkinParseError(`Scenario "${title}" has no steps.`);
  }

  // Attach data tables: schema requires every cell non-empty, so drop a table
  // that has any blank cell rather than emit something that fails validation.
  const stepsWithTables: GherkinStep[] = steps.map((step, index) => {
    const rows = stepRows.get(index);
    if (!rows || rows.length === 0) {
      return step;
    }
    const allNonEmpty = rows.every((row) => row.length > 0 && row.every((cell) => cell.length > 0));
    return allNonEmpty ? { ...step, dataTable: rows } : step;
  });

  // Examples are only valid with non-empty headers; otherwise drop them (and
  // the outline degrades to a plain scenario).
  const hasValidExamples =
    examplesHeaders !== undefined &&
    examplesHeaders.length > 0 &&
    examplesHeaders.every((header) => header.length > 0) &&
    examplesRows.length > 0;

  return {
    title,
    tags,
    outline,
    steps: stepsWithTables,
    ...(hasValidExamples
      ? { examples: { headers: examplesHeaders as string[], rows: examplesRows } }
      : {}),
  };
}

/**
 * Parse an Xray Cucumber test's Gherkin into a full {@link GherkinScenario},
 * synthesizing the structured fields Xray does not carry (acIds, risk,
 * readiness, objective, evidence, …). `fallbackTitle` (the Xray test summary)
 * is used as the feature name and as the title when the body has none.
 */
export function parseGherkinScenario(gherkin: string, fallbackTitle: string): GherkinScenario {
  const parsed = parseGherkinBody(gherkin);
  const title = parsed.title?.trim() || fallbackTitle;
  return {
    kind: "gherkin",
    title,
    feature: fallbackTitle,
    tags: parsed.tags,
    acIds: [],
    risk: "medium",
    readiness: "ready",
    objective: `Implement the Xray Cucumber test "${title}".`,
    preconditions: [],
    steps: parsed.steps,
    ...(parsed.examples ? { examples: parsed.examples } : {}),
    sourceEvidence: [],
    openQuestions: [],
    rationale: "Reconstructed from linked Xray Cucumber test.",
  };
}
