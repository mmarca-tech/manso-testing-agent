import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MonthlyReleaseNotesPack, ReleaseNotesPack } from "../../domain/releaseNotes/schema.js";
import {
  renderMonthlyExternalMarkdown,
  renderMonthlyTeamReleaseNotesMarkdown,
  renderReleaseNotesMarkdown,
  renderTeamReleaseNotesMarkdown,
} from "./renderer.js";

export interface WriteReleaseNotesResult {
  jsonPath: string;
  /** Internal, team-template notes with ticket links. */
  markdownPath: string;
  /** External-facing notes with no ticket keys, branches or PR info. */
  externalMarkdownPath: string;
}

/**
 * Write a {@link ReleaseNotesPack} to disk as
 * `<outDir>/<ISSUE-KEY>/release-notes.json` plus sibling
 * `release-notes.md` (internal) and `release-notes.external.md`. Returns the
 * paths it touched.
 */
export async function writeReleaseNotesPack(pack: ReleaseNotesPack, outDir: string): Promise<WriteReleaseNotesResult> {
  const directory = join(outDir, sanitizePathSegment(pack.releaseIssueKey));
  const jsonPath = join(directory, "release-notes.json");
  const markdownPath = join(directory, "release-notes.md");
  const externalMarkdownPath = join(directory, "release-notes.external.md");

  await mkdir(directory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderTeamReleaseNotesMarkdown(pack), "utf8");
  await writeFile(externalMarkdownPath, renderReleaseNotesMarkdown(pack), "utf8");

  return { jsonPath, markdownPath, externalMarkdownPath };
}

/**
 * Write a {@link MonthlyReleaseNotesPack} as
 * `<outDir>/<PROJECT>-<YYYY-MM>/release-notes.json` plus sibling internal and
 * external markdown, mirroring {@link writeReleaseNotesPack}.
 */
export async function writeMonthlyReleaseNotesPack(
  pack: MonthlyReleaseNotesPack,
  outDir: string,
): Promise<WriteReleaseNotesResult> {
  const directory = join(outDir, sanitizePathSegment(`${pack.project}-${pack.month}`));
  const jsonPath = join(directory, "release-notes.json");
  const markdownPath = join(directory, "release-notes.md");
  const externalMarkdownPath = join(directory, "release-notes.external.md");

  await mkdir(directory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderMonthlyTeamReleaseNotesMarkdown(pack), "utf8");
  await writeFile(externalMarkdownPath, renderMonthlyExternalMarkdown(pack), "utf8");

  return { jsonPath, markdownPath, externalMarkdownPath };
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  return sanitized === "." || sanitized === ".." ? "_" : sanitized;
}
