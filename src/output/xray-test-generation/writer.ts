import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { XrayTestGenerationPack } from "../../domain/xrayTestGeneration/schema.js";
import { mirrorArtifactSetToMemory } from "../../memory/memoryCabin.js";
import { renderXrayTestGenerationMarkdown } from "./renderer.js";

export interface WriteXrayTestGenerationResult {
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

export async function writeXrayTestGenerationPack(
  pack: XrayTestGenerationPack,
  directory: string,
): Promise<WriteXrayTestGenerationResult> {
  const jsonPath = join(directory, "xray-test-generation.json");
  const markdownPath = join(directory, "xray-test-generation.md");

  await mkdir(directory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderXrayTestGenerationMarkdown(pack), "utf8");
  await mirrorArtifactSetToMemory({
    workflow: "xray-test-generation",
    directory,
    files: [
      { path: jsonPath, kind: "json" },
      { path: markdownPath, kind: "markdown" },
    ],
  });

  return { directory, jsonPath, markdownPath };
}
