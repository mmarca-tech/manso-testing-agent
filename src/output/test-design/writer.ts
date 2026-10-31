import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestDesignPack, TestScenario } from "../../domain/testDesignPack/schema.js";
import { featureFileSlug, renderFeatureFile, renderManualTests, renderTestDesignMarkdown } from "./renderer.js";
import { registerCabinArtifacts } from "../../memory/cabin.js";

export interface WriteTestDesignResult {
  directory: string;
  jsonPath: string;
  markdownPath: string;
  featurePaths: string[];
  /** Set when the pack contains plain-English (manual) scenarios. */
  manualTestsPath?: string;
}

/**
 * Write a {@link TestDesignPack} to disk:
 *   - `<outDir>/<ISSUE-KEY>/test-design.json`
 *   - `<outDir>/<ISSUE-KEY>/test-design.md`
 *   - `<outDir>/<ISSUE-KEY>/features/<feature>.feature` (one per Feature)
 */
export async function writeTestDesignPack(
  pack: TestDesignPack,
  outDir: string,
): Promise<WriteTestDesignResult> {
  const directory = join(outDir, sanitizePathSegment(pack.ticket.key));
  const featuresDirectory = join(directory, "features");
  const jsonPath = join(directory, "test-design.json");
  const markdownPath = join(directory, "test-design.md");

  await mkdir(directory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderTestDesignMarkdown(pack), "utf8");

  // One `.feature` file per Feature that has at least one Gherkin scenario.
  const featurePaths: string[] = [];
  const grouped = groupGherkinScenariosByFeature(pack);
  if (grouped.size > 0) {
    await mkdir(featuresDirectory, { recursive: true });
    const usedSlugs = new Set<string>();
    for (const [feature, scenarios] of grouped) {
      let slug = featureFileSlug(feature);
      let attempt = 1;
      while (usedSlugs.has(slug)) {
        attempt += 1;
        slug = `${featureFileSlug(feature)}-${attempt}`;
      }
      usedSlugs.add(slug);
      const path = join(featuresDirectory, `${slug}.feature`);
      const content = renderFeatureFile({ ticketKey: pack.ticket.key, feature, scenarios });
      await writeFile(path, content, "utf8");
      featurePaths.push(path);
    }
  }

  // A single manual-tests doc when any plain-English scenarios are present.
  let manualTestsPath: string | undefined;
  if (pack.scenarios.some((scenario) => scenario.kind === "plain-english")) {
    manualTestsPath = join(directory, "manual-tests.md");
    await writeFile(
      manualTestsPath,
      renderManualTests({ ticketKey: pack.ticket.key, scenarios: pack.scenarios }),
      "utf8",
    );
  }

  registerCabinArtifacts({ directory, paths: [jsonPath, markdownPath, ...featurePaths, ...(manualTestsPath ? [manualTestsPath] : [])] });
  return {
    directory,
    jsonPath,
    markdownPath,
    featurePaths,
    ...(manualTestsPath ? { manualTestsPath } : {}),
  };
}

/** Group only the Gherkin scenarios by feature (plain-English go to manual-tests). */
function groupGherkinScenariosByFeature(pack: TestDesignPack): Map<string, TestScenario[]> {
  const map = new Map<string, TestScenario[]>();
  for (const scenario of pack.scenarios) {
    if (scenario.kind !== "gherkin") continue;
    const existing = map.get(scenario.feature) ?? [];
    existing.push(scenario);
    map.set(scenario.feature, existing);
  }
  return map;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}
