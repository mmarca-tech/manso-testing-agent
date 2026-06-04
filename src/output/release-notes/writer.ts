import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReleaseNotesPack } from "../../domain/releaseNotes/schema.js";
import { mirrorArtifactSetToMemory } from "../../memory/memoryCabin.js";
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
  await mirrorArtifactSetToMemory({
    workflow: "release-notes",
    directory,
    files: [
      { path: jsonPath, kind: "json" },
      { path: markdownPath, kind: "markdown" },
    ],
  });

  return { directory, jsonPath, markdownPath };
}
