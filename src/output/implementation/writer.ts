import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImplementationPack } from "../../domain/implementationPack/schema.js";
import { renderImplementationMarkdown } from "./renderer.js";
import { registerCabinArtifacts } from "../../memory/cabin.js";

export interface WriteImplementationResult {
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

/** Write `implementation.json` + `implementation.md` to `<outDir>/<KEY>/`. */
export async function writeImplementationPack(
  pack: ImplementationPack,
  outDir: string,
): Promise<WriteImplementationResult> {
  const directory = join(outDir, sanitizePathSegment(pack.ticket.key));
  const jsonPath = join(directory, "implementation.json");
  const markdownPath = join(directory, "implementation.md");

  await mkdir(directory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderImplementationMarkdown(pack), "utf8");
  registerCabinArtifacts({ directory, paths: [jsonPath, markdownPath] });

  return { directory, jsonPath, markdownPath };
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}
