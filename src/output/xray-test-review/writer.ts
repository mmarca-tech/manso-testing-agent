import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { XrayTestReviewPack } from "../../domain/xrayTestReview/schema.js";
import { mirrorArtifactSetToMemory } from "../../memory/memoryCabin.js";
import { renderXrayTestReviewMarkdown } from "./renderer.js";

export interface WriteXrayTestReviewResult {
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

export async function writeXrayTestReviewPack(
  pack: XrayTestReviewPack,
  directory: string,
): Promise<WriteXrayTestReviewResult> {
  const jsonPath = join(directory, "xray-test-review.json");
  const markdownPath = join(directory, "xray-test-review.md");

  await mkdir(directory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderXrayTestReviewMarkdown(pack), "utf8");
  await mirrorArtifactSetToMemory({
    workflow: "xray-test-review",
    directory,
    files: [
      { path: jsonPath, kind: "json" },
      { path: markdownPath, kind: "markdown" },
    ],
  });

  return { directory, jsonPath, markdownPath };
}
