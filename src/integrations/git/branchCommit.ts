import { runShellCommand } from "../shell/runShellCommand.js";

/**
 * Token-based push authentication for unattended (pipeline) runs.
 *
 * `extraHeader` is injected via `git -c http.extraHeader=...` so the secret
 * never appears in the remote URL (and is never written to the markdown report
 * — the executed command is logged in a redacted form using `description`).
 * When omitted, the push falls back to the host's local git credentials
 * (credential helper, SSH key, or a token baked into the origin URL).
 */
export interface GitPushAuth {
  /** e.g. "Authorization: Basic <base64>". Carries a secret — never log verbatim. */
  extraHeader: string;
  /** Safe label for logs/telemetry, e.g. "github (token)". */
  description: string;
}

export interface CommitChangesInput {
  /** Absolute path to the target repository root. */
  repoRoot: string;
  /** Branch name to create or check out. */
  branchName: string;
  /** Commit message. */
  commitMessage: string;
  /** When true, `git push --set-upstream origin <branch>` after committing. */
  push?: boolean;
  /**
   * Token-based push auth. When set, the push uses `http.extraHeader`; when
   * omitted, the push relies on the host's local git credentials.
   */
  pushAuth?: GitPushAuth;
  /** Author override (`Name <email>`). When omitted, the repo's existing config wins. */
  author?: string;
}

export interface CommitChangesResult {
  /** Branch the changes were committed on. */
  branch: string;
  /** True when at least one file was staged + committed. */
  committed: boolean;
  /** True when `git push` ran and exited 0. */
  pushed: boolean;
  /** Human-readable per-step messages, useful for the markdown report. */
  log: string[];
  /** Non-fatal warnings (e.g. push failed but commit succeeded). */
  warnings: string[];
}

interface StepResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface RunStepOptions {
  /** When set, a non-zero exit appends a warning prefixed with this label. */
  warnLabel?: string;
  /**
   * Command string written to the log instead of `command`. Use when the real
   * command embeds a secret (e.g. an auth header) that must not be logged.
   */
  displayCommand?: string;
}

async function runStep(
  command: string,
  cwd: string,
  log: string[],
  warnings: string[],
  options: RunStepOptions = {},
): Promise<StepResult> {
  const result = await runShellCommand(command, { cwd });
  const ok = result.exitCode === 0;
  log.push(`$ ${options.displayCommand ?? command}${ok ? "" : ` (exit ${result.exitCode})`}`);
  if (!ok && options.warnLabel && result.stderr) {
    warnings.push(`${options.warnLabel}: ${result.stderr.trim().slice(0, 500)}`);
  }
  return { ok, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Create/check out the branch, stage + commit any working-tree changes, and
 * optionally push. Idempotent: if the branch already exists it is checked out;
 * if there are no changes the commit is skipped without error.
 *
 * Returns a structured result; never throws on a non-zero git exit — failures
 * are recorded as warnings so the caller can decide how to surface them.
 */
export async function commitChangesOnBranch(input: CommitChangesInput): Promise<CommitChangesResult> {
  const log: string[] = [];
  const warnings: string[] = [];
  const cwd = input.repoRoot;

  const insideTree = await runStep("git rev-parse --is-inside-work-tree", cwd, log, warnings);
  if (!insideTree.ok || insideTree.stdout.trim() !== "true") {
    warnings.push("Target path is not inside a git working tree; nothing was committed.");
    return { branch: input.branchName, committed: false, pushed: false, log, warnings };
  }

  // Try to switch to an existing branch first. Failure is expected when the
  // branch is new, so we silence its warning; the fallback creates it.
  const switchExisting = await runStep(
    `git switch ${quoteArg(input.branchName)}`,
    cwd,
    log,
    warnings,
  );
  if (!switchExisting.ok) {
    const createBranch = await runStep(
      `git switch -c ${quoteArg(input.branchName)}`,
      cwd,
      log,
      warnings,
      { warnLabel: "git switch -c" },
    );
    if (!createBranch.ok) {
      warnings.push(`Could not create or check out branch "${input.branchName}".`);
      return { branch: input.branchName, committed: false, pushed: false, log, warnings };
    }
  }

  await runStep("git add -A", cwd, log, warnings, { warnLabel: "git add" });

  const status = await runStep("git status --porcelain", cwd, log, warnings, { warnLabel: "git status" });
  if (status.stdout.trim().length === 0) {
    return { branch: input.branchName, committed: false, pushed: false, log, warnings };
  }

  const authorFlag = input.author ? ` --author=${quoteArg(input.author)}` : "";
  const commit = await runStep(
    `git commit -m ${quoteArg(input.commitMessage)}${authorFlag}`,
    cwd,
    log,
    warnings,
    { warnLabel: "git commit" },
  );
  if (!commit.ok) {
    warnings.push("git commit failed; no commit was created.");
    return { branch: input.branchName, committed: false, pushed: false, log, warnings };
  }

  if (!input.push) {
    return { branch: input.branchName, committed: true, pushed: false, log, warnings };
  }

  // Token-based push (pipeline-friendly) injects the auth header via `-c`, so
  // the secret never lands in the origin URL or the logged command. Without
  // pushAuth we fall back to the host's local git credentials.
  const pushBase = `push --set-upstream origin ${quoteArg(input.branchName)}`;
  const pushCommand = input.pushAuth
    ? `git -c http.extraHeader=${quoteArg(input.pushAuth.extraHeader)} ${pushBase}`
    : `git ${pushBase}`;
  const push = await runStep(pushCommand, cwd, log, warnings, {
    warnLabel: "git push",
    ...(input.pushAuth
      ? { displayCommand: `git -c http.extraHeader=<redacted:${input.pushAuth.description}> ${pushBase}` }
      : {}),
  });

  return {
    branch: input.branchName,
    committed: true,
    pushed: push.ok,
    log,
    warnings,
  };
}

/** Default branch name for an implementation run: the Jira issue key as-is
 *  (e.g. `FINT-1056`), sanitised for git ref rules — original casing kept, no
 *  `manso/` prefix. */
export function defaultBranchName(issueKey: string): string {
  return issueKey.trim().replace(/[^A-Za-z0-9._-]/g, "-") || "manso-work";
}

function quoteArg(value: string): string {
  // Cross-shell-friendly quoting: wrap in double quotes, escape any nested double quotes.
  return `"${value.replace(/"/g, '\\"')}"`;
}
