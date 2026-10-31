import { describe, expect, it, vi } from "vitest";
import { startEnvironment, stopEnvironment, type EnvironmentConfig } from "../src/agents/environment/index.js";
import type { ShellRunResult } from "../src/integrations/shell/runShellCommand.js";

const ok = (command: string): ShellRunResult => ({ command, exitCode: 0, durationMs: 1, stdout: "", stderr: "" });
const fail = (command: string): ShellRunResult => ({ command, exitCode: 1, durationMs: 1, stdout: "", stderr: "boom" });
const immediateSleep = () => Promise.resolve();

describe("startEnvironment", () => {
  it("starts when setup succeeds and the app becomes reachable", async () => {
    const runShell = vi.fn(async (c: string) => ok(c));
    const fetchFn = vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    const cfg: EnvironmentConfig = { setupCommand: "docker compose up -d", appUrl: "http://localhost:8080" };

    const res = await startEnvironment(cfg, { repoRoot: "/repo", runShell, fetchFn, sleep: immediateSleep });

    expect(res.started).toBe(true);
    expect(runShell).toHaveBeenCalledWith("docker compose up -d", expect.objectContaining({ cwd: "/repo" }));
    expect(fetchFn).toHaveBeenCalled();
  });

  it("does not start when the setup command fails", async () => {
    const runShell = vi.fn(async (c: string) => fail(c));
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const res = await startEnvironment(
      { setupCommand: "docker compose up", appUrl: "http://localhost:8080" },
      { repoRoot: "/repo", runShell, fetchFn, sleep: immediateSleep },
    );
    expect(res.started).toBe(false);
    expect(res.message).toContain("setup command failed");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not start when the app never becomes ready (timeout)", async () => {
    const runShell = vi.fn(async (c: string) => ok(c));
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await startEnvironment(
      { setupCommand: "up", appUrl: "http://localhost:8080", timeoutMs: 30, pollIntervalMs: 5 },
      { repoRoot: "/repo", runShell, fetchFn, sleep: immediateSleep },
    );
    expect(res.started).toBe(false);
    expect(res.message).toContain("did not become ready");
  });

  it("treats a non-5xx response (even 404) as ready", async () => {
    const runShell = vi.fn(async (c: string) => ok(c));
    const fetchFn = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const res = await startEnvironment(
      { setupCommand: "up", readyUrl: "http://localhost:8080/health" },
      { repoRoot: "/repo", runShell, fetchFn, sleep: immediateSleep },
    );
    expect(res.started).toBe(true);
  });

  it("starts without a readiness check when no URL is configured", async () => {
    const runShell = vi.fn(async (c: string) => ok(c));
    const res = await startEnvironment({ setupCommand: "up" }, { repoRoot: "/repo", runShell });
    expect(res.started).toBe(true);
    expect(res.message).toContain("no readiness check");
  });
});

describe("stopEnvironment", () => {
  it("runs the teardown command when configured", async () => {
    const runShell = vi.fn(async (c: string) => ok(c));
    await stopEnvironment({ setupCommand: "up", teardownCommand: "docker compose down -v" }, { repoRoot: "/repo", runShell });
    expect(runShell).toHaveBeenCalledWith("docker compose down -v", expect.objectContaining({ cwd: "/repo" }));
  });

  it("is a no-op when no teardown command is configured", async () => {
    const runShell = vi.fn(async (c: string) => ok(c));
    await stopEnvironment({ setupCommand: "up" }, { repoRoot: "/repo", runShell });
    expect(runShell).not.toHaveBeenCalled();
  });
});
