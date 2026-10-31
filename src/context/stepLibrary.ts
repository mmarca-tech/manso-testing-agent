import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/** A unique, normalized step already present in the repository's feature files. */
export interface StepLibraryEntry {
  /** Display keyword (Given/When/Then). And/But/* are resolved to the prior concrete keyword. */
  keyword: "Given" | "When" | "Then";
  /** Step text with literals replaced by placeholders, for dedup + matching. */
  normalized: string;
  /** A few representative raw step texts as written in the repo. */
  examples: string[];
  /** How many step lines collapsed into this normalized entry. */
  occurrences: number;
}

/** A scenario / scenario outline already present in the repository. */
export interface ExistingScenario {
  /** Scenario title as written. */
  title: string;
  /** Owning Feature name (best effort). */
  feature: string;
  /** True when declared as `Scenario Outline`. */
  outline: boolean;
}

/**
 * Inventory of existing test material in a repository: the step vocabulary
 * (for step reuse) and the scenario titles (for test-case de-duplication).
 */
export interface StepLibrary {
  steps: StepLibraryEntry[];
  scenarios: ExistingScenario[];
  featureFileCount: number;
  totalSteps: number;
}

export interface ExtractStepLibraryOptions {
  /** Absolute path to the target repository. */
  repoRoot: string;
  /** Cap on unique steps returned (most-frequent first). Default 300. */
  maxSteps?: number;
  /** Representative raw examples kept per unique step. Default 3. */
  maxExamplesPerStep?: number;
  /** Cap on unique scenario titles returned. Default 400. */
  maxScenarios?: number;
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".agents",
  ".agent",
  ".idea",
  ".vs",
  "bin",
  "obj",
  "dist",
  "out",
  "build",
  "coverage",
  "target",
]);
const MAX_DEPTH = 8;
const DEFAULT_MAX_STEPS = 300;
const DEFAULT_MAX_EXAMPLES = 3;
const DEFAULT_MAX_SCENARIOS = 400;

const STEP_RE = /^(Given|When|Then|And|But|\*)\s+(.*\S)\s*$/;
const BOUNDARY_RE = /^(Scenario|Scenario Outline|Background|Example|Rule|Feature)\b/;
const FEATURE_RE = /^Feature:\s*(.+\S)\s*$/;
const SCENARIO_RE = /^(Scenario Outline|Scenario):\s*(.+\S)\s*$/;

type ConcreteKeyword = "Given" | "When" | "Then";

interface Accumulator {
  keyword: ConcreteKeyword;
  normalized: string;
  examples: string[];
  occurrences: number;
}

/**
 * Replace value-like literals with placeholders so structurally identical steps
 * collapse to one entry: `300.00 EUR` / `50.00 EUR` → `<number> EUR`, quoted
 * values → `"<param>"`, and Scenario-Outline placeholders → `<param>`.
 */
export function normalizeStepText(text: string): string {
  return text
    .replace(/"[^"]*"/g, '"<param>"')
    .replace(/'[^']*'/g, "'<param>'")
    .replace(/<[^>]+>/g, "<param>")
    .replace(/\b\d+(?:[.,]\d+)?\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Scan a repository's `.feature` files and build a deduplicated, normalized
 * inventory of the steps already in use. Feeding this to the Gherkin author
 * lets it reuse existing step phrasings (which already have step definitions)
 * instead of inventing near-duplicates that would need new bindings.
 */
export async function extractStepLibrary(options: ExtractStepLibraryOptions): Promise<StepLibrary> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxExamples = options.maxExamplesPerStep ?? DEFAULT_MAX_EXAMPLES;
  const maxScenarios = options.maxScenarios ?? DEFAULT_MAX_SCENARIOS;

  const featureFiles = await collectFeatureFiles(options.repoRoot);
  const byNormalized = new Map<string, Accumulator>();
  const scenarioByTitle = new Map<string, ExistingScenario>();
  let totalSteps = 0;

  for (const file of featureFiles) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }

    let currentKeyword: ConcreteKeyword = "Given";
    let currentFeature = "";
    let inDocString = false;
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith('"""') || line.startsWith("```")) {
        inDocString = !inDocString;
        continue;
      }
      if (inDocString || line.length === 0 || line.startsWith("#") || line.startsWith("@") || line.startsWith("|")) {
        continue;
      }

      const featureMatch = FEATURE_RE.exec(line);
      if (featureMatch) {
        currentFeature = (featureMatch[1] ?? "").trim();
        currentKeyword = "Given";
        continue;
      }
      const scenarioMatch = SCENARIO_RE.exec(line);
      if (scenarioMatch) {
        currentKeyword = "Given";
        const title = (scenarioMatch[2] ?? "").trim();
        const titleKey = title.toLowerCase().replace(/\s+/g, " ").trim();
        if (title.length > 0 && !scenarioByTitle.has(titleKey)) {
          scenarioByTitle.set(titleKey, {
            title,
            feature: currentFeature,
            outline: scenarioMatch[1] === "Scenario Outline",
          });
        }
        continue;
      }
      if (BOUNDARY_RE.test(line)) {
        currentKeyword = "Given";
        continue;
      }
      const match = STEP_RE.exec(line);
      if (!match) {
        continue;
      }

      const rawKeyword = match[1] ?? "";
      const stepText = (match[2] ?? "").trim();
      if (rawKeyword === "Given" || rawKeyword === "When" || rawKeyword === "Then") {
        currentKeyword = rawKeyword;
      }
      const normalized = normalizeStepText(stepText);
      if (normalized.length === 0) {
        continue;
      }
      totalSteps += 1;

      const key = normalized.toLowerCase();
      const existing = byNormalized.get(key);
      if (existing) {
        existing.occurrences += 1;
        if (existing.examples.length < maxExamples && !existing.examples.includes(stepText)) {
          existing.examples.push(stepText);
        }
      } else {
        byNormalized.set(key, {
          keyword: currentKeyword,
          normalized,
          examples: [stepText],
          occurrences: 1,
        });
      }
    }
  }

  const steps = [...byNormalized.values()]
    .sort((a, b) => b.occurrences - a.occurrences || a.normalized.localeCompare(b.normalized))
    .slice(0, maxSteps)
    .map((entry) => ({
      keyword: entry.keyword,
      normalized: entry.normalized,
      examples: entry.examples,
      occurrences: entry.occurrences,
    }));

  const scenarios = [...scenarioByTitle.values()].slice(0, maxScenarios);

  return {
    steps,
    scenarios,
    featureFileCount: featureFiles.length,
    totalSteps,
  };
}

/** Render the step library as a prompt section. Empty string when there are no steps. */
export function formatStepLibraryForPrompt(library: StepLibrary): string {
  if (library.steps.length === 0) {
    return "";
  }

  const grouped: Record<ConcreteKeyword, string[]> = { Given: [], When: [], Then: [] };
  for (const step of library.steps) {
    grouped[step.keyword].push(step.normalized);
  }

  const lines: string[] = [];
  lines.push(
    `# Existing step vocabulary in the target repository (${library.steps.length} unique step(s) across ${library.featureFileCount} feature file(s))`,
  );
  lines.push(
    "REUSE these exact step phrasings wherever they fit a scenario — they already have step definitions in the repo. Only write a NEW step when none of these matches the behaviour, and keep any new step consistent with this style. Placeholders: `\"<param>\"` = any quoted value, `<number>` = any number, `<param>` = any value.",
  );
  for (const keyword of ["Given", "When", "Then"] as const) {
    const entries = grouped[keyword];
    if (entries.length > 0) {
      lines.push("", `${keyword}:`);
      for (const entry of entries) {
        lines.push(`- ${entry}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Render the existing scenarios as a prompt section telling the author not to
 * duplicate them. Empty string when there are none.
 */
export function formatExistingScenariosForPrompt(scenarios: ExistingScenario[]): string {
  if (scenarios.length === 0) {
    return "";
  }

  const lines: string[] = [];
  lines.push(`# Existing test cases in the target repository (${scenarios.length})`);
  lines.push(
    "These scenarios already exist in the repo's feature files. Do NOT author a new scenario that means the same thing as one of these. When an acceptance criterion is ALREADY fully covered by one of these existing scenarios, put that AC id in `acsCoveredByExisting` instead of writing a duplicate scenario for it.",
  );
  for (const scenario of scenarios) {
    const kind = scenario.outline ? "Scenario Outline" : "Scenario";
    lines.push(`- ${kind}: ${scenario.title}${scenario.feature ? ` (Feature: ${scenario.feature})` : ""}`);
  }
  return lines.join("\n");
}

export interface ResolveDesignRepoInput {
  /** Explicit `--repo` path (highest priority). */
  explicit?: string;
  /** Ticket development section from the ContextPack. */
  development?: {
    branches: ReadonlyArray<{ repository?: string | undefined }>;
    pullRequests: ReadonlyArray<{ repository?: string | undefined }>;
  };
  /** Map of repository name → local checkout path (e.g. from MANSO_REPO_ROOTS). */
  repoRoots?: Record<string, string>;
}

export interface ResolvedDesignRepo {
  repoRoot: string;
  source: "flag" | "dev-section";
  /** Repository name when resolved from the ticket's dev section. */
  repository?: string;
}

/**
 * Decide which repository to read existing steps from:
 *   1. An explicit `--repo` path always wins.
 *   2. Otherwise, a repository named in the ticket's dev section that has a
 *      local checkout mapped in `repoRoots`.
 *   3. Otherwise undefined — design proceeds without an existing-step library.
 */
export function resolveDesignRepo(input: ResolveDesignRepoInput): ResolvedDesignRepo | undefined {
  if (input.explicit && input.explicit.trim().length > 0) {
    return { repoRoot: resolve(input.explicit), source: "flag" };
  }

  const roots = input.repoRoots ?? {};
  const names: string[] = [];
  for (const branch of input.development?.branches ?? []) {
    if (branch.repository) names.push(branch.repository);
  }
  for (const pr of input.development?.pullRequests ?? []) {
    if (pr.repository) names.push(pr.repository);
  }

  for (const name of names) {
    const mapped = roots[name];
    if (mapped && mapped.trim().length > 0) {
      return { repoRoot: resolve(mapped), source: "dev-section", repository: name };
    }
  }

  return undefined;
}

async function collectFeatureFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) {
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          await walk(join(dir, entry.name), depth + 1);
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".feature")) {
        found.push(join(dir, entry.name));
      }
    }
  }

  await walk(root, 0);
  // Stable order independent of filesystem enumeration.
  return found.sort((a, b) => a.split(sep).join("/").localeCompare(b.split(sep).join("/")));
}
