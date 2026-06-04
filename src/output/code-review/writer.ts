import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeReviewPack } from "../../domain/codeReview/schema.js";
import { mirrorArtifactSetToMemory } from "../../memory/memoryCabin.js";
import { renderCodeReviewMarkdown } from "./renderer.js";

export interface WriteCodeReviewResult {
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

export async function writeCodeReviewPack(pack: CodeReviewPack, outDir: string): Promise<WriteCodeReviewResult> {
  const directory = join(outDir, `pr-${pack.pullRequest.id}`);
  const jsonPath = join(directory, "code-review.json");
  const markdownPath = join(directory, "code-review.md");

  await mkdir(directory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderCodeReviewMarkdown(pack), "utf8");
  await mirrorArtifactSetToMemory({
    workflow: "code-review",
    directory,
    files: [
      { path: jsonPath, kind: "json" },
      { path: markdownPath, kind: "markdown" },
    ],
  });

  return { directory, jsonPath, markdownPath };
}
