import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { XrayTestDefinitionsPack } from "../../domain/xrayTestDefinitions/schema.js";
import { mirrorArtifactSetToMemory } from "../../memory/memoryCabin.js";
import { renderXrayTestDefinitionsMarkdown } from "./renderer.js";

export interface WriteXrayTestDefinitionsResult {
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

export async function writeXrayTestDefinitionsPack(
  pack: XrayTestDefinitionsPack,
  directory: string,
): Promise<WriteXrayTestDefinitionsResult> {
  const jsonPath = join(directory, "xray-test-definitions.json");
  const markdownPath = join(directory, "xray-test-definitions.md");

  await mkdir(directory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderXrayTestDefinitionsMarkdown(pack), "utf8");
  await mirrorArtifactSetToMemory({
    workflow: "xray-test-definitions",
    directory,
    files: [
      { path: jsonPath, kind: "json" },
      { path: markdownPath, kind: "markdown" },
    ],
  });

  return { directory, jsonPath, markdownPath };
}
