import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CliError } from "../shared/cli.js";
import { pathExists } from "../shared/fsUtils.js";
import { detectStacks, type DetectedStack } from "./stackDetection.js";
import { buildTemplateFiles } from "./templates.js";

export interface ScaffoldOptions {
  /** Absolute path to the target repository root. */
  repoRoot: string;
  /** When true, overwrite existing Manso files instead of refusing. */
  force: boolean;
}

export interface ScaffoldResult {
  repoRoot: string;
  /** Repo-relative paths written, POSIX-separated. */
  created: string[];
  /** Stacks detected and pre-filled into the config. */
  detectedStacks: DetectedStack[];
}

/**
 * Scaffold the `.agents/` folder (and a root `AGENTS.md`) into a repository.
 *
 * Refuses — with a clear {@link CliError} — if any target file already exists
 * and `force` is false, so re-running is safe and never silently overwrites.
 */
export async function scaffoldAgentFolder(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const { repoRoot, force } = options;

  if (!(await pathExists(repoRoot))) {
    throw new CliError(`Target repository path does not exist: ${repoRoot}`);
  }

  const detectedStacks = await detectStacks(repoRoot);
  const files = buildTemplateFiles({
    productName: basename(repoRoot),
    detectedStacks,
  });

  if (!force) {
    const conflicts: string[] = [];
    for (const file of files) {
      if (await pathExists(join(repoRoot, file.path))) {
        conflicts.push(file.path);
      }
    }
    if (conflicts.length > 0) {
      throw new CliError(
        [
          `Manso files already exist in ${repoRoot}:`,
          ...conflicts.map((conflict) => `  ${conflict}`),
          "Re-run with --force to overwrite them.",
        ].join("\n"),
      );
    }
  }

  const created: string[] = [];
  for (const file of files) {
    const absolutePath = join(repoRoot, file.path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.content, "utf8");
    created.push(file.path);
  }

  return { repoRoot, created, detectedStacks };
}
