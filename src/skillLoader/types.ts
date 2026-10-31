/** Lifecycle phases a skill applies to. */
export type SkillPhase = "design" | "implementation" | "context" | "ops";

export const SKILL_PHASES: readonly SkillPhase[] = [
  "design",
  "implementation",
  "context",
  "ops",
];

/** Filter clauses declared by a skill's frontmatter. */
export interface SkillAppliesTo {
  /** When set, the skill only applies to these stack ids (e.g. `playwright-bdd-ts`). */
  stacks?: string[];
  /** When set, the skill only applies to this lifecycle phase. */
  phase?: SkillPhase;
}

/** A loaded `SKILL.md` file with parsed metadata and body. */
export interface Skill {
  name: string;
  description: string;
  appliesTo?: SkillAppliesTo;
  /** Free-form "when to use" hint from the frontmatter. */
  when?: string;
  /** Markdown body following the frontmatter, trimmed. */
  body: string;
  /** Where this resolution came from. Repo overrides win over packaged. */
  source: "packaged" | "repo";
  /** Absolute file path of the SKILL.md, for debugging. */
  path: string;
}
