import { hostname } from "node:os";
import { open, readFile, stat, unlink } from "node:fs/promises";

/** A lock older than this is treated as abandoned even when its PID cannot be checked. */
export const DEFAULT_LOCK_STALE_AFTER_MS = 30 * 60 * 1000;

/** A lock without readable holder info may just be mid-creation; only trust its age after this grace. */
const UNREADABLE_LOCK_GRACE_MS = 60 * 1000;
/** The gate is held for milliseconds; one older than this was left by a process that died holding it. */
const GATE_STALE_AFTER_MS = 10 * 1000;
const GATE_WAIT_MS = 5 * 1000;
const GATE_POLL_MS = 20;

interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

export interface AcquireLockOptions {
  staleAfterMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  /** Injectable for tests; defaults to a signal-0 probe. */
  isProcessAlive?: (pid: number) => boolean;
}

export interface AcquiredLock {
  release(): Promise<void>;
  /** Set when an abandoned lock was taken over; explains why. */
  tookOverStale?: string;
}

export class LockBusyError extends Error {}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

function parseLock(text: string): LockInfo | undefined {
  try {
    const value = JSON.parse(text) as Partial<LockInfo>;
    if (typeof value.pid === "number" && typeof value.host === "string" && typeof value.startedAt === "string") return value as LockInfo;
  } catch { /* unreadable or legacy lock: the caller falls back to the file's age */ }
  return undefined;
}

/**
 * Exclusive lock file that records who holds it. A crashed run (Ctrl+C, OOM,
 * cancelled pipeline, restart) would otherwise block every later run until
 * someone deletes the file by hand, so a lock is taken over when its holder is
 * provably gone (same host, PID not alive) or it is older than `staleAfterMs`.
 * A live, recent lock is never removed.
 *
 * Deciding that a lock is stale and replacing it must be one atomic step, or
 * two contenders can both judge it stale and one deletes the lock the other
 * just created. Plain files have no atomic compare-and-replace, so every
 * operation on the lock (acquire, takeover and release) runs inside a short
 * critical section guarded by a separate gate file created with `wx`: while
 * someone holds the gate nobody else can create, replace or remove the lock.
 */
export async function acquireLock(path: string, options: AcquireLockOptions = {}): Promise<AcquiredLock> {
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS;
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const mine: LockInfo = { pid: process.pid, host: hostname(), startedAt: new Date(now()).toISOString() };
  const body = JSON.stringify(mine);

  const tookOverStale = await withGate(path, async () => {
    let takenOver: string | undefined;
    try {
      await createLockFile(path, body);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const text = await readFile(path, "utf8").catch(() => undefined);
      if (text !== undefined) {
        const mtimeMs = (await stat(path).catch(() => undefined))?.mtimeMs;
        const reason = staleReason(text, mtimeMs, now(), staleAfterMs, isAlive);
        if (!reason) throw new LockBusyError("locked or inaccessible");
        await unlink(path).catch(() => undefined);
        takenOver = reason;
      }
      // Safe to retry without racing anyone: all other lock operations wait on the gate.
      await createLockFile(path, body).catch((retryError: unknown) => {
        if (errorCode(retryError) === "EEXIST") throw new LockBusyError("locked or inaccessible");
        throw retryError;
      });
    }
    return takenOver;
  });

  return {
    ...(tookOverStale ? { tookOverStale } : {}),
    release: async () => {
      // Only remove a lock that is still ours; a takeover leaves different content.
      await withGate(path, async () => {
        const current = await readFile(path, "utf8").catch(() => undefined);
        if (current === body) await unlink(path).catch(() => undefined);
      }).catch(() => undefined);
    },
  };
}

async function createLockFile(path: string, body: string): Promise<void> {
  const handle = await open(path, "wx");
  try { await handle.writeFile(body, "utf8"); } finally { await handle.close(); }
}

/** Run `fn` while holding the gate; wait briefly for it and expire a gate left by a dead process. */
async function withGate<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const gatePath = `${lockPath}.gate`;
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const deadline = Date.now() + GATE_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(gatePath, "wx");
      try { await handle.writeFile(token, "utf8"); } finally { await handle.close(); }
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const mtimeMs = (await stat(gatePath).catch(() => undefined))?.mtimeMs;
      if (mtimeMs !== undefined && Date.now() - mtimeMs > GATE_STALE_AFTER_MS) {
        await unlink(gatePath).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) throw new LockBusyError("locked or inaccessible");
      await new Promise((resolve) => setTimeout(resolve, GATE_POLL_MS));
    }
  }
  try {
    return await fn();
  } finally {
    if ((await readFile(gatePath, "utf8").catch(() => undefined)) === token) await unlink(gatePath).catch(() => undefined);
  }
}

function staleReason(text: string, mtimeMs: number | undefined, nowMs: number, staleAfterMs: number, isAlive: (pid: number) => boolean): string | undefined {
  const info = parseLock(text);
  if (!info) {
    return mtimeMs !== undefined && nowMs - mtimeMs > UNREADABLE_LOCK_GRACE_MS
      ? "lock file had no readable holder information"
      : undefined;
  }
  const ageMs = nowMs - Date.parse(info.startedAt);
  if (Number.isFinite(ageMs) && ageMs > staleAfterMs) {
    return `lock held by pid ${info.pid} on ${info.host} since ${info.startedAt} exceeded ${Math.round(staleAfterMs / 60000)} minutes`;
  }
  if (info.host === hostname() && !isAlive(info.pid)) {
    return `lock holder pid ${info.pid} is no longer running`;
  }
  return undefined;
}
