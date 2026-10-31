import { spawn, type SpawnOptions } from "node:child_process";

export interface ShellRunResult {
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface ShellRunOptions {
  /** Working directory. */
  cwd: string;
  /** Environment overrides (merged on top of process.env). */
  env?: NodeJS.ProcessEnv;
  /** Optional stdin payload. */
  stdin?: string;
  /** Optional millisecond timeout. */
  timeoutMs?: number;
  /** Captured output is truncated past this length (per stream). */
  maxOutputChars?: number;
}

const DEFAULT_MAX_OUTPUT_CHARS = 200_000;

/**
 * Run a shell command, capturing stdout and stderr. Returns a structured
 * result; does not throw on non-zero exit. Output is bounded by
 * `maxOutputChars` to avoid runaway memory use.
 */
export async function runShellCommand(
  command: string,
  options: ShellRunOptions,
): Promise<ShellRunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const maxChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      shell: true,
      windowsHide: true,
    };

    const child = spawn(command, [], spawnOptions);
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"), maxChars);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"), maxChars);
    });

    let timeoutHandle: NodeJS.Timeout | undefined;
    if (options.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
    }

    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin);
      child.stdin?.end();
    }

    child.on("error", (error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({
        command,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`,
      });
    });

    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const exitCode = timedOut ? 124 : code ?? 0;
      const finalStderr = timedOut
        ? `${stderr}${stderr ? "\n" : ""}Command timed out after ${options.timeoutMs} ms`
        : stderr;
      resolve({
        command,
        exitCode,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: finalStderr,
      });
    });
  });
}

function appendCapped(current: string, chunk: string, max: number): string {
  if (current.length + chunk.length <= max) {
    return current + chunk;
  }
  if (current.length >= max) {
    return current;
  }
  return current + chunk.slice(0, max - current.length) + "\n[output truncated]";
}
