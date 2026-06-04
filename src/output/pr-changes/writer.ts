import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PrChangesPack } from "../../domain/prChanges/schema.js";
import { mirrorArtifactSetToMemory } from "../../memory/memoryCabin.js";
import { renderPrChangesMarkdown } from "./renderer.js";

export interface WritePrChangesResult {
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

export async function writePrChangesPack(pack: PrChangesPack, directory: string): Promise<WritePrChangesResult> {
  const jsonPath = join(directory, "pr-changes.json");
  const markdownPath = join(directory, "pr-changes.md");

  await mkdir(directory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderPrChangesMarkdown(pack), "utf8");
  await mirrorArtifactSetToMemory({
    workflow: "pr-changes",
    directory,
    files: [
      { path: jsonPath, kind: "json" },
      { path: markdownPath, kind: "markdown" },
    ],
  });

  return { directory, jsonPath, markdownPath };
}
