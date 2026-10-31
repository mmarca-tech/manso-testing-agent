import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { auditLogPath, readAuditLog, type AuditEntry } from "../policy/auditLog.js";
import { CliError } from "../shared/cli.js";
import type { CommandModule } from "./main.js";

const HELP = `manso audit - read Manso's append-only audit log.

Usage:
  manso audit [options]

Options:
  --log <path>     Audit log path. Defaults to MANSO_AUDIT_LOG or ./out/audit.jsonl.
  --action <name>  Only show entries with this action (e.g. pr.raised).
  --target <key>   Only show entries for this target (e.g. FINT-1056).
  --limit <n>      Show at most the last N entries. Default 50.
  --json           Print raw JSON entries instead of the table.
  -h, --help       Show this help.

The audit log records consequential actions (design.created, xray.uploaded,
pr.raised, pr.fix-applied, rule.proposed, budget.breached, run.started/completed)
with secrets redacted.
`;

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      log: { type: "string" },
      action: { type: "string" },
      target: { type: "string" },
      limit: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const path = values.log ? resolve(values.log) : auditLogPath(resolve("out"));
  const limit = values.limit !== undefined ? parsePositive(values.limit, "--limit") : 50;

  let entries = await readAuditLog(path);
  if (entries.length === 0) {
    console.log(`No audit entries at ${path}.`);
    return 0;
  }
  if (values.action) entries = entries.filter((e) => e.action === values.action);
  if (values.target) entries = entries.filter((e) => e.target === values.target);
  const shown = entries.slice(-limit);

  if (values.json) {
    console.log(JSON.stringify(shown, null, 2));
    return 0;
  }

  console.log(`Audit log: ${path}  (${shown.length} of ${entries.length} shown)`);
  for (const entry of shown) {
    console.log(`  ${entry.at}  ${entry.action.padEnd(16)}  ${entry.actor.padEnd(14)}  ${entry.target}`);
  }
  console.log("");
  console.log("Totals by action:");
  for (const [action, count] of countByAction(entries)) {
    console.log(`  ${action.padEnd(18)} ${count}`);
  }
  return 0;
}

function countByAction(entries: AuditEntry[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.action, (counts.get(entry.action) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function parsePositive(value: string, flag: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError(`${flag} must be a positive integer; got "${value}".`);
  }
  return n;
}

const command: CommandModule = { run };
export default command;
