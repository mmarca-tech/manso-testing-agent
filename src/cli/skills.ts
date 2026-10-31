import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadSkills } from "../skillLoader/loader.js";
import { SKILL_PHASES, type SkillPhase } from "../skillLoader/types.js";
import { CliError } from "../shared/cli.js";
import type { CommandModule } from "./main.js";

const HELP = `manso skills - list resolved skills (debug).

Usage:
  manso skills [--repo <path>] [--phase <phase>] [--stack <stack>]

Options:
  --repo <path>     Target repository (loads .agents/skills overrides).
  --phase <phase>   Filter: design | implementation | context | ops.
  --stack <stack>   Filter: stack id, e.g. playwright-bdd-ts.
  -h, --help        Show this help.
`;

function isSkillPhase(value: string): value is SkillPhase {
  return (SKILL_PHASES as readonly string[]).includes(value);
}

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      phase: { type: "string" },
      stack: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }

  let phase: SkillPhase | undefined;
  if (values.phase !== undefined) {
    if (!isSkillPhase(values.phase)) {
      throw new CliError(
        `Invalid --phase "${values.phase}". Expected one of: ${SKILL_PHASES.join(", ")}`,
      );
    }
    phase = values.phase;
  }

  const skills = await loadSkills({
    ...(values.repo ? { repoRoot: resolve(values.repo) } : {}),
    ...(phase ? { phase } : {}),
    ...(values.stack ? { stack: values.stack } : {}),
  });

  if (skills.length === 0) {
    console.log("No skills matched.");
    return 0;
  }

  for (const skill of skills) {
    const tag = skill.source === "repo" ? "(repo override)" : "(packaged)";
    const phaseTag = skill.appliesTo?.phase ? ` [phase: ${skill.appliesTo.phase}]` : "";
    const stacksTag =
      skill.appliesTo?.stacks && skill.appliesTo.stacks.length > 0
        ? ` [stacks: ${skill.appliesTo.stacks.join(", ")}]`
        : "";
    console.log(`- ${skill.name} ${tag}${phaseTag}${stacksTag}`);
    if (skill.description) {
      console.log(`    ${skill.description}`);
    }
  }
  return 0;
}

const command: CommandModule = { run };
export default command;
