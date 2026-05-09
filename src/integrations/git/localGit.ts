import { spawn } from "node:child_process";

export interface ProcessRunResult {
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface ShellRunResult {
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export async function runGit(repoRoot: string, args: string[]): Promise<ProcessRunResult> {
  const result = await runProcess("git", args, repoRoot);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`);
  }

  return result;
}

export async function runShellCommand(command: string, repoRoot: string, env: NodeJS.ProcessEnv, stdin?: string): Promise<ShellRunResult> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: repoRoot,
      env,
      shell: true,
      stdio: stdin === undefined ? ["inherit", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      process.stderr.write(chunk);
    });

    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        command,
        exitCode: exitCode ?? 1,
        durationMs: Date.now() - startedAt,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

export async function gitStatusPorcelain(repoRoot: string): Promise<string> {
  return (await runGit(repoRoot, ["status", "--porcelain"])).stdout;
}

export function parseGitChangedFiles(statusPorcelain: string): string[] {
  return statusPorcelain
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const path = line.slice(3).trim();
      const renamedPath = path.includes(" -> ") ? path.split(" -> ").at(-1) : path;
      return unquoteGitPath(renamedPath ?? path);
    })
    .filter((path) => path.length > 0);
}

export async function detectDefaultTargetBranch(repoRoot: string): Promise<string> {
  try {
    const originHead = (await runGit(repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).stdout.trim();
    const [, branch] = originHead.split("/");
    if (branch) {
      return branch;
    }
  } catch {
    // Fall through to the common default.
  }

  return "main";
}

export async function gitCurrentRemoteUrl(repoRoot: string): Promise<string> {
  return (await runGit(repoRoot, ["remote", "get-url", "origin"])).stdout.trim();
}

export async function gitCurrentHeadSha(repoRoot: string): Promise<string> {
  return (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
}

export async function gitCurrentBranch(repoRoot: string): Promise<string> {
  return (await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
}

async function runProcess(command: string, args: string[], cwd: string): Promise<ProcessRunResult> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        command: [command, ...args].join(" "),
        exitCode: exitCode ?? 1,
        durationMs: Date.now() - startedAt,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function unquoteGitPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  return trimmed;
}
