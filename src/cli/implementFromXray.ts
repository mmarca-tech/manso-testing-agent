import { extractStepLibrary } from "../context/stepLibrary.js";
import type { Warning } from "../domain/contextPack/schema.js";
import {
  TEST_DESIGN_SCHEMA_VERSION,
  TestDesignPackSchema,
  type GherkinScenario,
  type RiskLevel,
  type RiskRankingEntry,
  type TestDesignPack,
} from "../domain/testDesignPack/schema.js";
import type { AtlassianRestClient } from "../integrations/atlassianRest/client.js";
import type { XrayCloudClient } from "../integrations/xray/client.js";
import { GherkinParseError, parseGherkinScenario } from "../integrations/xray/gherkinParse.js";
import { fetchLinkedCucumberTests } from "../integrations/xray/testFetch.js";
import { firstString, normalizeTestTitle } from "../shared/utils.js";

export interface BuildTestDesignFromXrayInput {
  /** Story key whose linked Xray tests drive the implementation. */
  ticketKey: string;
  /** Target repo; its existing .feature scenario titles are used to skip already-implemented tests. */
  repoRoot: string;
  jira: AtlassianRestClient;
  xray: XrayCloudClient;
  onProgress?: (message: string) => void;
}

export interface BuildTestDesignFromXraySummary {
  ticketKey: string;
  linkedTests: number;
  alreadyImplemented: number;
  parseFailures: number;
  toImplement: number;
  warnings: Warning[];
}

export type BuildTestDesignFromXrayResult =
  | { kind: "pack"; pack: TestDesignPack; summary: BuildTestDesignFromXraySummary }
  | { kind: "nothing-to-do"; summary: BuildTestDesignFromXraySummary };

/**
 * Reconstruct a {@link TestDesignPack} for a story directly from Xray, for the
 * standalone `implement-tests --issue` path (no local design file).
 *
 * Fetches the story's linked Cucumber tests + their Gherkin, parses each into a
 * scenario, drops the ones whose title already exists in the repo's `.feature`
 * files, and assembles a minimal-but-valid pack from the survivors. When there
 * is nothing left to implement it returns `nothing-to-do` so the caller can
 * exit cleanly without invoking the implementation agent.
 */
export async function buildTestDesignFromXray(
  input: BuildTestDesignFromXrayInput,
): Promise<BuildTestDesignFromXrayResult> {
  const warnings: Warning[] = [];

  const ticketTitle = await fetchTicketTitle(input.jira, input.ticketKey);

  const fetched = await fetchLinkedCucumberTests({
    jira: input.jira,
    xray: input.xray,
    ticketKey: input.ticketKey,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });
  warnings.push(...fetched.warnings);

  const linkedTests = fetched.tests.length;
  if (linkedTests === 0) {
    return {
      kind: "nothing-to-do",
      summary: { ticketKey: input.ticketKey, linkedTests: 0, alreadyImplemented: 0, parseFailures: 0, toImplement: 0, warnings },
    };
  }

  // Parse each linked test's Gherkin into a structured scenario.
  let parseFailures = 0;
  const parsed: GherkinScenario[] = [];
  for (const test of fetched.tests) {
    try {
      parsed.push(parseGherkinScenario(test.gherkin, test.summary));
    } catch (error) {
      parseFailures += 1;
      warnings.push({
        section: "xrayFetch",
        toolName: "gherkin:parse",
        message: `Could not parse Gherkin for ${test.key} ("${test.summary}"): ${error instanceof GherkinParseError ? error.message : String(error)}`,
      });
    }
  }

  // Diff against the repo's existing scenario titles (and dedup among survivors).
  const library = await extractStepLibrary({ repoRoot: input.repoRoot });
  const existing = new Set(library.scenarios.map((scenario) => normalizeTestTitle(scenario.title)));
  input.onProgress?.(
    `Repo has ${library.scenarios.length} existing scenario title(s) across ${library.featureFileCount} feature file(s).`,
  );

  const survivors: GherkinScenario[] = [];
  const survivorTitles = new Set<string>();
  let alreadyImplemented = 0;
  for (const scenario of parsed) {
    const norm = normalizeTestTitle(scenario.title);
    if (existing.has(norm)) {
      alreadyImplemented += 1;
      continue;
    }
    if (survivorTitles.has(norm)) {
      continue; // duplicate title among the linked tests
    }
    survivorTitles.add(norm);
    survivors.push(scenario);
  }

  const summary: BuildTestDesignFromXraySummary = {
    ticketKey: input.ticketKey,
    linkedTests,
    alreadyImplemented,
    parseFailures,
    toImplement: survivors.length,
    warnings,
  };

  if (survivors.length === 0) {
    return { kind: "nothing-to-do", summary };
  }

  const pack = TestDesignPackSchema.parse({
    schemaVersion: TEST_DESIGN_SCHEMA_VERSION,
    ticket: { key: input.ticketKey, title: ticketTitle },
    outputMode: "gherkin",
    acceptanceCriteria: [],
    strategySummary: `Reconstructed from ${survivors.length} linked Xray Cucumber test(s) for ${input.ticketKey} (not yet in the repo).`,
    coverageGaps: [],
    scenarios: survivors,
    acCoverageMatrix: [],
    riskRanking: buildRiskRanking(survivors),
    openQuestions: [],
    provenance: {
      generatedAt: new Date().toISOString(),
      issueKey: input.ticketKey,
      llm: { provider: "anthropic", model: "xray-reconstruction" },
      tools: [],
    },
    warnings,
  });

  return { kind: "pack", pack, summary };
}

/** Best-effort story title via the Jira issue summary; falls back to the key. */
async function fetchTicketTitle(jira: AtlassianRestClient, ticketKey: string): Promise<string> {
  try {
    const issue = await jira.getJson("jira", `/rest/api/3/issue/${encodeURIComponent(ticketKey)}`, {
      fields: "summary",
    });
    return firstString(issue, ["fields.summary", "summary"]) ?? ticketKey;
  } catch {
    return ticketKey;
  }
}

/** Group scenario indexes by risk level (matches the design-phase shape). */
function buildRiskRanking(scenarios: GherkinScenario[]): RiskRankingEntry[] {
  const byRisk = new Map<RiskLevel, number[]>();
  scenarios.forEach((scenario, index) => {
    const list = byRisk.get(scenario.risk) ?? [];
    list.push(index);
    byRisk.set(scenario.risk, list);
  });
  return [...byRisk.entries()].map(([level, scenarioIndexes]) => ({ level, scenarioIndexes }));
}
