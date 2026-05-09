import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReleaseNotesPack } from "../../domain/releaseNotes/schema.js";
import { renderReleaseNotesMarkdown } from "./renderer.js";

export interface WriteReleaseNotesResult {
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

export async function writeReleaseNotesPack(pack: ReleaseNotesPack, outDir: string): Promise<WriteReleaseNotesResult> {
  const directory = join(outDir, pack.releaseTicket.key);
  const jsonPath = join(directory, "release-notes.json");
  const markdownPath = join(directory, "release-notes.md");

  await mkdir(directory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderReleaseNotesMarkdown(pack), "utf8");

  return { directory, jsonPath, markdownPath };
}
