import { CliError } from "../shared/cli.js";
import { SKILL_PHASES, type Skill, type SkillAppliesTo, type SkillPhase } from "./types.js";

interface ParseSkillInput {
  text: string;
  source: Skill["source"];
  path: string;
}

/**
 * Parse a `SKILL.md` file: YAML-frontmatter delimited by `---` markers, then a
 * Markdown body. Restricted to the shape Manso emits:
 *   - top-level key: value pairs (`name`, `description`, `when`)
 *   - `appliesTo: { phase: <phase>[, stacks: [a, b]] }` (flow form)
 *
 * Hand-rolled to avoid a YAML dependency; throws {@link CliError} on malformed
 * frontmatter so the loader can surface the file path to the user.
 */
export function parseSkill(input: ParseSkillInput): Skill {
  const text = input.text.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) {
    throw new CliError(`Skill file is missing YAML frontmatter: ${input.path}`);
  }

  const frontmatter = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  const fields = parseFrontmatter(frontmatter, input.path);

  if (!fields.name) {
    throw new CliError(`Skill at ${input.path} is missing a "name" frontmatter key.`);
  }

  return {
    name: fields.name,
    description: fields.description ?? "",
    body,
    source: input.source,
    path: input.path,
    ...(fields.when ? { when: fields.when } : {}),
    ...(fields.appliesTo ? { appliesTo: fields.appliesTo } : {}),
  };
}

interface ParsedFields {
  name?: string;
  description?: string;
  when?: string;
  appliesTo?: SkillAppliesTo;
}

function parseFrontmatter(frontmatter: string, path: string): ParsedFields {
  const fields: ParsedFields = {};
  for (const rawLine of frontmatter.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }
    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();
    if (key === "name") {
      fields.name = stripQuotes(rawValue);
    } else if (key === "description") {
      fields.description = stripQuotes(rawValue);
    } else if (key === "when") {
      fields.when = stripQuotes(rawValue);
    } else if (key === "appliesTo") {
      fields.appliesTo = parseAppliesTo(rawValue, path);
    }
  }
  return fields;
}

function parseAppliesTo(input: string, path: string): SkillAppliesTo {
  const result: SkillAppliesTo = {};

  const phaseMatch = /phase\s*:\s*([\w-]+)/.exec(input);
  if (phaseMatch) {
    const phase = phaseMatch[1] ?? "";
    if (!(SKILL_PHASES as readonly string[]).includes(phase)) {
      throw new CliError(
        `Skill ${path} has an invalid phase "${phase}". Expected one of: ${SKILL_PHASES.join(", ")}`,
      );
    }
    result.phase = phase as SkillPhase;
  }

  const stacksMatch = /stacks\s*:\s*\[([^\]]*)\]/.exec(input);
  if (stacksMatch) {
    result.stacks = (stacksMatch[1] ?? "")
      .split(",")
      .map((entry) => stripQuotes(entry.trim()))
      .filter((entry) => entry.length > 0);
  }

  return result;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
