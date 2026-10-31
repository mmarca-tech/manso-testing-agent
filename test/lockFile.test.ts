import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, LockBusyError } from "../src/policy/lockFile.js";

describe("acquireLock", () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "manso-lock-"));
    path = join(dir, "x.lock");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  const held = (info: { pid: number; host?: string; startedAt?: string }) =>
    writeFile(path, JSON.stringify({ host: hostname(), startedAt: new Date().toISOString(), ...info }));

  it("records the holder and releases only its own lock", async () => {
    const lock = await acquireLock(path);
    expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid);
    await lock.release();
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("refuses a lock held by a live process, without removing it", async () => {
    await held({ pid: process.pid });
    const before = await readFile(path, "utf8");
    await expect(acquireLock(path)).rejects.toBeInstanceOf(LockBusyError);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("takes over a lock whose process is gone on this host", async () => {
    await held({ pid: 424242 });
    const lock = await acquireLock(path, { isProcessAlive: () => false });
    expect(lock.tookOverStale).toContain("no longer running");
    expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid);
  });

  it("takes over a lock older than the timeout even if the holder cannot be checked", async () => {
    await held({ pid: 1, host: "some-other-host", startedAt: new Date(Date.now() - 31 * 60_000).toISOString() });
    const lock = await acquireLock(path);
    expect(lock.tookOverStale).toContain("exceeded 30 minutes");
  });

  it("keeps a recent lock held on another host", async () => {
    await held({ pid: 1, host: "some-other-host" });
    await expect(acquireLock(path, { isProcessAlive: () => false })).rejects.toBeInstanceOf(LockBusyError);
  });

  it("does not take over a fresh lock whose holder info is not written yet", async () => {
    await writeFile(path, "");
    await expect(acquireLock(path)).rejects.toBeInstanceOf(LockBusyError);
  });

  it("lets exactly one of many concurrent contenders take over a stale lock", async () => {
    await held({ pid: 424242 });
    const results = await Promise.allSettled(Array.from({ length: 12 }, () =>
      acquireLock(path, { isProcessAlive: (pid) => pid === process.pid })));
    const winners = results.filter((result) => result.status === "fulfilled");
    expect(winners).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(LockBusyError);
    }
    // The winner's lock is intact: nobody deleted it while taking over.
    expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid);
  });

  it("does not let a stale holder's late release remove its replacement", async () => {
    const first = await acquireLock(path);
    // Pretend the first run was judged abandoned and replaced.
    await rm(path);
    const second = await acquireLock(path);
    await first.release();
    expect(await readFile(path, "utf8")).toBeDefined();
    await second.release();
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("expires a gate left behind by a process that died while holding it", async () => {
    const gate = `${path}.gate`;
    await writeFile(gate, "dead-process");
    const old = new Date(Date.now() - 60_000);
    await utimes(gate, old, old);
    const lock = await acquireLock(path);
    await lock.release();
    await expect(readFile(gate, "utf8")).rejects.toThrow();
  });

  it("takes over an old lock with no readable holder info", async () => {
    await writeFile(path, "legacy");
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(path, old, old);
    const lock = await acquireLock(path);
    expect(lock.tookOverStale).toContain("no readable holder");
  });
});
