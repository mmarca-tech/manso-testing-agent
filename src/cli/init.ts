import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { scaffoldAgentFolder } from "../scaffold/scaffold.js";
import type { CommandModule } from "./main.js";

const HELP = `manso init - scaffold the .agents/ folder in a target repository.

Usage:
  manso init [--repo <path>] [--force]

Options:
  --repo <path>   Target repository root. Defaults to the current directory.
  --force         Overwrite existing Manso files.
  -h, --help      Show this help.
`;

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const repoRoot = resolve(values.repo ?? process.cwd());
  const result = await scaffoldAgentFolder({ repoRoot, force: values.force ?? false });

  console.log(`Scaffolded Manso configuration in ${repoRoot}`);
  for (const file of result.created) {
    console.log(`  created  ${file}`);
  }

  if (result.detectedStacks.length > 0) {
    console.log(`Detected stacks: ${result.detectedStacks.map((stack) => stack.id).join(", ")}`);
  } else {
    console.log("No known test stacks were detected; edit .agents/manso.config.json manually.");
  }

  console.log(`Next: run "manso check --repo ${repoRoot}" to score readiness.`);
  return 0;
}

const command: CommandModule = { run };
export default command;
