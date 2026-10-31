import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_DIR, resolveAgentDir } from "../config/agentConfig.js";
import { parseSkill } from "./parser.js";
import type { Skill, SkillPhase } from "./types.js";

const SKILL_FILENAME = "SKILL.md";

/**
 * Folder containing skills shipped with Manso. Resolves to `<pkg>/skills/`
 * both in development (running from `src/`) and when the package is installed
 * (running from `dist/`), as long as the published artifact keeps `skills/` at
 * the package root (see `files` in `package.json`).
 */
export function packagedSkillsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "skills");
}

/** Folder containing repo-specific skill overrides for the given repo root. */
export function repoSkillsRoot(repoRoot: string, dir: string = AGENT_DIR): string {
  return join(repoRoot, dir, "skills");
}

export interface LoadSkillsOptions {
  /** Target repository whose `.agents/skills/` overrides packaged skills. */
  repoRoot?: string;
  /** Restrict to skills declaring this phase (skills with no phase pass through). */
  phase?: SkillPhase;
  /** Restrict to skills declaring this stack (skills with no stacks pass through). */
  stack?: string;
}

/**
 * Load packaged skills and repo overrides, with progressive disclosure: only
 * skills whose `appliesTo` allows the requested phase and stack come back.
 * Repo `.agents/skills/<name>` always wins over packaged `<pkg>/skills/<name>`.
 */
export async function loadSkills(options: LoadSkillsOptions = {}): Promise<Skill[]> {
  const byName = new Map<string, Skill>();

  for (const dir of await listSkillDirs(packagedSkillsRoot())) {
    const skill = await readSkillFile(dir, "packaged");
    if (skill) {
      byName.set(skill.name, skill);
    }
  }

  if (options.repoRoot) {
    const agentDir = await resolveAgentDir(options.repoRoot);
    for (const dir of await listSkillDirs(repoSkillsRoot(options.repoRoot, agentDir))) {
      const skill = await readSkillFile(dir, "repo");
      if (skill) {
        byName.set(skill.name, skill);
      }
    }
  }

  return [...byName.values()].filter((skill) => matchesFilters(skill, options));
}

async function listSkillDirs(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      result.push(join(root, entry.name));
    }
  }
  return result;
}

async function readSkillFile(dir: string, source: Skill["source"]): Promise<Skill | undefined> {
  const path = join(dir, SKILL_FILENAME);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  return parseSkill({ text, source, path });
}

function matchesFilters(skill: Skill, options: LoadSkillsOptions): boolean {
  if (options.phase) {
    const phase = skill.appliesTo?.phase;
    if (phase && phase !== options.phase) {
      return false;
    }
  }
  if (options.stack) {
    const stacks = skill.appliesTo?.stacks;
    if (stacks && stacks.length > 0 && !stacks.includes(options.stack)) {
      return false;
    }
  }
  return true;
}
