import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConfluenceImpactPack } from "../../domain/confluenceImpact/schema.js";
import { mirrorArtifactSetToMemory } from "../../memory/memoryCabin.js";
import { renderConfluenceImpactMarkdown } from "./renderer.js";

export interface WriteConfluenceImpactResult {
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

export async function writeConfluenceImpactPack(pack: ConfluenceImpactPack, directory: string): Promise<WriteConfluenceImpactResult> {
  const jsonPath = join(directory, "confluence-impact.json");
  const markdownPath = join(directory, "confluence-impact.md");

  await mkdir(directory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderConfluenceImpactMarkdown(pack), "utf8");
  await mirrorArtifactSetToMemory({
    workflow: "confluence-impact",
    directory,
    files: [
      { path: jsonPath, kind: "json" },
      { path: markdownPath, kind: "markdown" },
    ],
  });

  return { directory, jsonPath, markdownPath };
}
