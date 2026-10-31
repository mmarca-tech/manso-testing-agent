import { runShellCommand, type ShellRunResult } from "../../integrations/shell/runShellCommand.js";

/**
 * Environment lifecycle for M20 (environment-aware implementation).
 *
 * When a stack configures a `setupCommand` (typically `docker compose up`),
 * Manso brings the test environment up once around the implement+verify
 * cycle, waits for it to become reachable, and tears it down afterwards. Every
 * step is best-effort: if Docker isn't available, the command fails, or the app
 * never becomes ready, `startEnvironment` reports `started: false` and the
 * caller falls back to today's behaviour without blocking.
 */
export interface EnvironmentConfig {
  /** Command that brings the environment up (run once). */
  setupCommand: string;
  /** Command that tears it down (run once, best-effort). */
  teardownCommand?: string;
  /** Base URL of the running app. */
  appUrl?: string;
  /** URL polled for readiness; defaults to {@link appUrl}. */
  readyUrl?: string;
  /** Max ms to wait for both setup and readiness. Default 120000. */
  timeoutMs?: number;
  /** Readiness poll interval ms. Default 3000. */
  pollIntervalMs?: number;
}

type RunShell = (
  command: string,
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<ShellRunResult>;

export interface EnvironmentContext {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  onProgress?: (message: string) => void;
  /** Injected for tests (defaults to the real shell runner). */
  runShell?: RunShell;
  /** Injected for tests (defaults to global fetch). */
  fetchFn?: typeof fetch;
  /** Injected for tests (defaults to real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

export interface EnvironmentStartResult {
  /** True only when setup succeeded AND the app became reachable. */
  started: boolean;
  message: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 3_000;

/**
 * Run the setup command and wait until the app is reachable. Returns
 * `started: false` (never throws) when Docker/setup fails or readiness times
 * out, so the caller can fall back gracefully.
 */
export async function startEnvironment(
  config: EnvironmentConfig,
  ctx: EnvironmentContext,
): Promise<EnvironmentStartResult> {
  const run = ctx.runShell ?? runShellCommand;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  ctx.onProgress?.(`Environment: starting via \`${config.setupCommand}\`...`);
  let setup: ShellRunResult;
  try {
    setup = await run(config.setupCommand, {
      cwd: ctx.repoRoot,
      ...(ctx.env ? { env: ctx.env } : {}),
      timeoutMs,
    });
  } catch (error) {
    return { started: false, message: `setup command could not run: ${errorMessage(error)}` };
  }
  if (setup.exitCode !== 0) {
    return {
      started: false,
      message: `setup command failed (exit ${setup.exitCode}): ${(setup.stderr || setup.stdout).trim().slice(0, 300)}`,
    };
  }

  const readyUrl = config.readyUrl ?? config.appUrl;
  if (!readyUrl) {
    ctx.onProgress?.("Environment: setup succeeded (no readiness URL configured; assuming ready).");
    return { started: true, message: "started (no readiness check)" };
  }

  const ready = await waitForReady(readyUrl, config, ctx);
  if (!ready) {
    return { started: false, message: `app did not become ready at ${readyUrl} within ${timeoutMs} ms` };
  }
  ctx.onProgress?.(`Environment: ready at ${readyUrl}.`);
  return { started: true, message: `ready at ${readyUrl}` };
}

/** Tear the environment down (best-effort; never throws). */
export async function stopEnvironment(config: EnvironmentConfig, ctx: EnvironmentContext): Promise<void> {
  if (!config.teardownCommand) {
    return;
  }
  const run = ctx.runShell ?? runShellCommand;
  ctx.onProgress?.(`Environment: tearing down via \`${config.teardownCommand}\`...`);
  try {
    await run(config.teardownCommand, {
      cwd: ctx.repoRoot,
      ...(ctx.env ? { env: ctx.env } : {}),
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } catch {
    /* teardown is best-effort */
  }
}

async function waitForReady(url: string, config: EnvironmentConfig, ctx: EnvironmentContext): Promise<boolean> {
  const fetchFn = ctx.fetchFn ?? fetch;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const interval = config.pollIntervalMs ?? DEFAULT_POLL_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const res = await fetchFn(url, { method: "GET" });
      // Any non-5xx response means the server is up and listening.
      if (res.status < 500) {
        return true;
      }
    } catch {
      /* connection refused / not up yet */
    }
    ctx.onProgress?.(`Environment: waiting for ${url} (attempt ${attempt})...`);
    await sleep(interval);
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
