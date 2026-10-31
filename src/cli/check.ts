import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { evaluateRepoReadiness } from "../checks/readiness.js";
import { loadRuntimeConfig } from "../config/runtimeConfig.js";
import type { CheckStatus } from "../domain/readinessReport/schema.js";
import type { CommandModule } from "./main.js";

const HELP = `manso check - score a repository's Manso readiness.

Usage:
  manso check [--repo <path>] [--config <path>]

Options:
  --repo <path>     Repository to assess. Defaults to the current directory.
  --config <path>   Optional JSON runtime-config file for non-secret overrides.
  -h, --help        Show this help.

Exits 1 when a mandatory file is missing or the config is invalid.
`;

const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
};

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const repoRoot = resolve(values.repo ?? process.cwd());
  const runtimeConfig = await loadRuntimeConfig(values.config ? { configPath: values.config } : {});
  const report = await evaluateRepoReadiness({ repoRoot, runtimeConfig });

  console.log(`Manso readiness for ${repoRoot}`);
  for (const check of report.checks) {
    console.log(`  [${STATUS_LABEL[check.status]}] ${check.name}: ${check.message}`);
  }
  console.log(`Score: ${report.score}/100`);

  if (report.hardFailure) {
    console.error('Repository is not ready. Run "manso init" to scaffold the missing files.');
    return 1;
  }
  return 0;
}

const command: CommandModule = { run };
export default command;
