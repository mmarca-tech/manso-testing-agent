import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildRedactor } from "./redaction.js";

/**
 * Append-only audit log (M14 governance).
 *
 * Records every consequential action Manso takes — design written, Xray
 * upload, PR raised, fix applied, rule proposed — as one JSON object per line
 * (JSONL). Secrets in the detail are redacted before writing. The log is the
 * governance trail an operator reviews after the fact; it is never read back to
 * drive behaviour.
 */

export const AUDIT_ACTIONS = [
  "design.created",
  "xray.uploaded",
  "pr.raised",
  "pr.fix-applied",
  "pr.reviewed",
  "pr.review-comment-requested",
  "pr.review-commented",
  "rule.proposed",
  "budget.breached",
  "run.started",
  "run.completed",
  "memory.read",
  "memory.mirrored",
  "memory.failed",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  at: string;
  action: AuditAction;
  /** Who/what triggered it, e.g. "cli", "respond-to-pr". */
  actor: string;
  /** What it acted on, e.g. a ticket key, PR id, repo. */
  target: string;
  /** Free-form structured detail (string values are redacted). */
  detail?: Record<string, unknown>;
}

export interface AppendAuditInput {
  /** Absolute path to the JSONL audit file. */
  path: string;
  action: AuditAction;
  actor: string;
  target: string;
  detail?: Record<string, unknown>;
  /** Custom redaction patterns from policy.redactPatterns. */
  redactPatterns?: string[];
  now?: () => Date;
}

/** Append one redacted audit entry as a JSONL line. */
export async function appendAuditEntry(input: AppendAuditInput): Promise<AuditEntry> {
  const redactor = buildRedactor(input.redactPatterns ?? []);
  const now = input.now ?? (() => new Date());
  const entry: AuditEntry = {
    at: now().toISOString(),
    action: input.action,
    actor: input.actor,
    target: redactor.redact(input.target),
    ...(input.detail ? { detail: redactor.redactRecord(input.detail) } : {}),
  };

  await mkdir(dirname(input.path), { recursive: true });
  await appendFile(input.path, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

/**
 * Resolve the audit-log path: the `MANSO_AUDIT_LOG` env override, else
 * `<baseDir>/audit.jsonl`.
 */
export function auditLogPath(baseDir: string): string {
  const override = process.env.MANSO_AUDIT_LOG;
  return override && override.trim().length > 0 ? override.trim() : join(baseDir, "audit.jsonl");
}

/**
 * Fire-and-forget audit emission: append an entry, swallowing any error so a
 * failed audit write never fails the run. Returns true on success.
 */
export async function emitAudit(input: AppendAuditInput): Promise<boolean> {
  try {
    await appendAuditEntry(input);
    return true;
  } catch {
    return false;
  }
}

/** Read and parse a JSONL audit log (skips malformed lines). */
export async function readAuditLog(path: string): Promise<AuditEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const entries: AuditEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      entries.push(JSON.parse(trimmed) as AuditEntry);
    } catch {
      // skip malformed line
    }
  }
  return entries;
}
