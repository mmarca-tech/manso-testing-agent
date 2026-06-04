import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextPack } from "../../domain/contextPack/schema.js";
import { mirrorArtifactSetToMemory } from "../../memory/memoryCabin.js";
import { renderMarkdown } from "./renderer.js";

export interface WriteResult {
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

export async function writeContextPack(context: ContextPack, outDir: string): Promise<WriteResult> {
  const directory = join(outDir, sanitizePathSegment(context.ticket.key));
  const jsonPath = join(directory, "context.json");
  const markdownPath = join(directory, "context.md");

  await mkdir(directory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderMarkdown(context), "utf8");
  await mirrorArtifactSetToMemory({
    workflow: "context-pack",
    directory,
    files: [
      { path: jsonPath, kind: "json" },
      { path: markdownPath, kind: "markdown" },
    ],
  });

  return { directory, jsonPath, markdownPath };
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}
