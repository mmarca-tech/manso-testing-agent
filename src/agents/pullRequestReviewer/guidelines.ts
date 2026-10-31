import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { resolveAgentDir } from "../../config/agentConfig.js";

const MAX_FILES = 8;
const MAX_CHARS = 2000;
/** Upper bound on bytes read per file; the prompt keeps only MAX_CHARS of them. */
const MAX_READ_BYTES = 64 * 1024;

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Load the target repository's review guidelines (`<agent dir>/guidelines/*.md`).
 *
 * The checkout is untrusted in PR validation: a pull request can add a symlink
 * such as `guidelines/leak.md -> /path/to/secret`, and following it would send
 * an arbitrary host file to the LLM. So symbolic links are never followed (for
 * the directory or its files), only regular files are read, and every real path
 * must stay inside the guidelines directory inside the repository.
 */
export async function readGuidelines(repoRoot: string): Promise<{ text: string; warnings: string[] }> {
  const directory = join(repoRoot, await resolveAgentDir(repoRoot), "guidelines");
  const warnings: string[] = [];
  try {
    const stats = await lstat(directory);
    if (!stats.isDirectory()) {
      return { text: "", warnings: ["Repository guidelines were ignored: the guidelines path is not a regular directory (symbolic links are not followed)."] };
    }
  } catch (error) {
    if (isMissing(error)) return { text: "", warnings: [] };
    throw error;
  }
  const realDirectory = await realpath(directory);
  if (!isInside(await realpath(repoRoot), realDirectory)) {
    return { text: "", warnings: ["Repository guidelines were ignored: the guidelines directory resolves outside the repository."] };
  }

  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith(".md"))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: Array<{ name: string; content: string }> = [];
  for (const entry of entries.slice(0, MAX_FILES)) {
    // Dirent reports a symlink as such (it does not follow it).
    if (!entry.isFile()) {
      warnings.push(`Repository guideline ${entry.name} was skipped: not a regular file (symbolic links are not followed).`);
      continue;
    }
    const content = await readRegularFile(join(directory, entry.name), realDirectory);
    if (content === undefined) {
      warnings.push(`Repository guideline ${entry.name} was skipped: it is not a regular file inside the guidelines directory.`);
      continue;
    }
    files.push({ name: entry.name, content });
  }
  warnings.push(...files.filter((file) => file.content.length > MAX_CHARS).map((file) => `Repository guideline ${file.name} was bounded at ${MAX_CHARS} characters.`));
  if (entries.length > MAX_FILES) warnings.push(`Repository guideline loading was capped at ${MAX_FILES} Markdown files.`);
  return { text: files.map((file) => `## ${file.name}\n${file.content.slice(0, MAX_CHARS)}`).join("\n"), warnings };
}

/** Read a regular file without following a link at its final component; undefined if it is not safe. */
async function readRegularFile(path: string, realDirectory: string): Promise<string | undefined> {
  let handle;
  try {
    // O_NOFOLLOW is unavailable on some platforms (0 there); the realpath and
    // fstat checks below still reject links that were swapped in after readdir.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = await handle.stat();
    if (!stats.isFile()) return undefined;
    const real = await realpath(path);
    if (!isInside(realDirectory, real)) return undefined;
    const buffer = Buffer.alloc(Math.min(stats.size, MAX_READ_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}
