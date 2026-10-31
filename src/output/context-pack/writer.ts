import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextPack } from "../../domain/contextPack/schema.js";
import { renderMarkdown } from "./renderer.js";
import { registerCabinArtifacts } from "../../memory/cabin.js";

export interface WriteResult {
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

/**
 * Write a {@link ContextPack} to disk as `<outDir>/<ISSUE-KEY>/context.json`
 * plus a sibling `context.md`. Returns the paths it touched.
 */
export async function writeContextPack(context: ContextPack, outDir: string): Promise<WriteResult> {
  const directory = join(outDir, sanitizePathSegment(context.ticket.key));
  const jsonPath = join(directory, "context.json");
  const markdownPath = join(directory, "context.md");

  await mkdir(directory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderMarkdown(context), "utf8");
  registerCabinArtifacts({ directory, paths: [jsonPath, markdownPath] });

  return { directory, jsonPath, markdownPath };
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}
