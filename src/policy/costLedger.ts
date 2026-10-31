import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { roundUsd } from "../shared/utils.js";

/**
 * Append-only per-run cost ledger (M15). Records the measured USD cost of each
 * run as one JSON line, so the daily-budget check can sum today's spend and
 * halt before an unattended pipeline overspends. Pure I/O — the budget decision
 * itself lives in {@link checkBudget}.
 */

export interface CostLedgerEntry {
  at: string;
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  runCostUsd: number;
  issueKey?: string;
  command?: string;
}

/** Resolve the ledger path: `MANSO_COST_LEDGER` env override, else `<baseDir>/cost-ledger.jsonl`. */
export function costLedgerPath(baseDir: string): string {
  const override = process.env.MANSO_COST_LEDGER;
  return override && override.trim().length > 0 ? override.trim() : join(baseDir, "cost-ledger.jsonl");
}

/** Calendar day (YYYY-MM-DD) for a Date. */
export function ledgerDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Append a run's measured cost. Fire-and-forget friendly (callers may ignore errors). */
export async function appendRunCost(
  path: string,
  entry: { runCostUsd: number; issueKey?: string; command?: string; now?: () => Date },
): Promise<CostLedgerEntry> {
  const now = entry.now ?? (() => new Date());
  const at = now();
  const record: CostLedgerEntry = {
    at: at.toISOString(),
    day: ledgerDay(at),
    runCostUsd: roundUsd(entry.runCostUsd),
    ...(entry.issueKey ? { issueKey: entry.issueKey } : {}),
    ...(entry.command ? { command: entry.command } : {}),
  };
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

/** Sum the recorded cost for a given day. Returns 0 when the ledger is absent. */
export async function readDayCost(path: string, day: string = ledgerDay(), options: { strict?: boolean } = {}): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (options.strict && !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return 0;
  }
  let total = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const entry = JSON.parse(trimmed) as Partial<CostLedgerEntry>;
      if (options.strict && (typeof entry.day !== "string" || typeof entry.runCostUsd !== "number" ||
          !Number.isFinite(entry.runCostUsd) || entry.runCostUsd < 0)) {
        throw new Error("Invalid cost ledger entry.");
      }
      if (entry.day === day && typeof entry.runCostUsd === "number") {
        total += entry.runCostUsd;
      }
    } catch (error) {
      if (options.strict) throw error;
      // skip malformed line
    }
  }
  return roundUsd(total);
}
