import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveAgentDir } from "../config/agentConfig.js";
import { pathExists } from "../shared/fsUtils.js";

/**
 * Repo guidance loading (M25) — the durable team knowledge Manso's agents
 * read before working in a repo:
 *
 *   - `AGENTS.md` (root knowledge base / agent guide)
 *   - `.agents/test-architecture.md`, `.agents/test-conventions.json`,
 *     `.agents/product-context.md`
 *   - **`.agents/guidelines/*.md`** — the rules the learning engine proposes
 *     and humans merge. Before M25 these were written but never read back, so
 *     learned rules improved nothing; now BOTH the Test Architect (design) and
 *     the Implementer consume them.
 *
 * Bounded: each file is clipped and a total budget stops runaway prompt growth,
 * with explicit warnings (no silent truncation).
 */

export interface RepoGuidanceFile {
  /** Repo-relative path of the loaded file. */
  path: string;
  content: string;
}

export interface LoadRepoGuidanceOptions {
  /** Per-file clip, chars. Default 6000. */
  maxFileChars?: number;
  /** Total budget across files, chars. Default 20000. */
  maxTotalChars?: number;
}

export interface RepoGuidanceResult {
  files: RepoGuidanceFile[];
  warnings: string[];
}

/** Root knowledge-base / agent guide docs, read regardless of the agent dir. */
const ROOT_GUIDANCE_FILES = ["AGENTS.md"];
/** Guidance file names inside the resolved agent dir (`.agents` or legacy `.agent`). */
const AGENT_GUIDANCE_FILENAMES = [
  "test-architecture.md",
  "test-conventions.json",
  "product-context.md",
];
/** Directory of learned rules (learning engine proposals merged by humans). */
const GUIDELINES_DIR = "guidelines";

export async function loadRepoGuidance(
  repoRoot: string,
  options: LoadRepoGuidanceOptions = {},
): Promise<RepoGuidanceResult> {
  const maxFileChars = options.maxFileChars ?? 6000;
  const maxTotalChars = options.maxTotalChars ?? 20000;
  const warnings: string[] = [];

  const agentDir = await resolveAgentDir(repoRoot);
  const relPaths: string[] = [
    ...ROOT_GUIDANCE_FILES,
    ...AGENT_GUIDANCE_FILENAMES.map((name) => join(agentDir, name)),
    ...(await listGuidelineFiles(repoRoot, agentDir)),
  ];

  const files: RepoGuidanceFile[] = [];
  let spent = 0;
  for (const relPath of relPaths) {
    const absolute = join(repoRoot, relPath);
    if (!(await pathExists(absolute))) continue;
    let content: string;
    try {
      content = await readFile(absolute, "utf8");
    } catch {
      continue; // unreadable — skip silently, matching prior behavior
    }
    if (content.trim().length === 0) continue;

    // Omit (rather than sliver-clip) once the remaining budget is too small
    // to carry meaningful content (a quarter of the budget, capped at 200).
    const minUseful = Math.min(200, Math.max(1, Math.floor(maxTotalChars / 4)));
    if (maxTotalChars - spent < minUseful) {
      warnings.push(`Guidance budget (${maxTotalChars} chars) reached — omitted ${relPath}.`);
      continue;
    }
    let clipped = content;
    if (clipped.length > maxFileChars) {
      clipped = `${clipped.slice(0, maxFileChars)}\n...(truncated)`;
      warnings.push(`Guidance file ${relPath} clipped to ${maxFileChars} chars.`);
    }
    if (spent + clipped.length > maxTotalChars) {
      clipped = `${clipped.slice(0, Math.max(0, maxTotalChars - spent))}\n...(truncated)`;
      warnings.push(`Guidance file ${relPath} clipped by the total budget.`);
    }
    files.push({ path: relPath, content: clipped });
    spent += clipped.length;
  }
  return { files, warnings };
}

/** `.agents/guidelines/*.md`, sorted for stable prompt ordering. */
async function listGuidelineFiles(repoRoot: string, agentDir: string): Promise<string[]> {
  const dir = join(repoRoot, agentDir, GUIDELINES_DIR);
  if (!(await pathExists(dir))) return [];
  try {
    const entries = await readdir(dir);
    return entries
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .sort()
      .map((name) => join(agentDir, GUIDELINES_DIR, name));
  } catch {
    return [];
  }
}
