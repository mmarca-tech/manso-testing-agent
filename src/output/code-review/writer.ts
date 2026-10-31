import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeReviewPack } from "../../domain/codeReview/schema.js";
import { renderCodeReviewMarkdown } from "./renderer.js";

/** Persist the redacted report under a safe PR-specific directory. */
export async function writeCodeReviewPack(pack: CodeReviewPack, outDir: string) {
  const directory = join(outDir, `pr-${pack.pullRequest.id}`);
  const jsonPath = join(directory, "code-review.json");
  const markdownPath = join(directory, "code-review.md");
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, renderCodeReviewMarkdown(pack), "utf8"),
  ]);
  return { jsonPath, markdownPath };
}
