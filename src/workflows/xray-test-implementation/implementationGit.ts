import { relative } from "node:path";
import { CliError } from "../../shared/cli.js";
import {
  detectDefaultTargetBranch,
  gitStatusPorcelain,
  parseGitChangedFiles,
  runGit,
} from "../../integrations/git/localGit.js";
import type { ToolProvenance } from "../../domain/contextPack/schema.js";

export async function resolveTargetBranch(repoRoot: string, targetBranch: string | undefined): Promise<string> {
  return normalizeBranchName(targetBranch ?? process.env.SYSTEM_PULLREQUEST_TARGETBRANCH ?? await detectDefaultTargetBranch(repoRoot));
}

export function defaultImplementationBranch(issueKey: string): string {
  return `tests/${issueKey.toLowerCase()}-xray-implementation`
    .replace(/[^a-z0-9/_-]+/gi, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "");
}

export function normalizeBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, "");
}

export async function assertCleanWorktree(repoRoot: string, allowDirty: boolean): Promise<string[]> {
  const startingChangedFiles = parseGitChangedFiles(await gitStatusPorcelain(repoRoot));
  if (!allowDirty && startingChangedFiles.length > 0) {
    throw new CliError(`Refusing to implement tests with a dirty worktree. Commit, stash, or pass --allow-dirty. Current changes: ${startingChangedFiles.join(", ")}`);
  }

  return startingChangedFiles;
}

export async function checkoutImplementationBranch(input: {
  repoRoot: string;
  branch: string;
  targetBranch: string;
  reuseBranchIfPossible?: boolean;
  tools: ToolProvenance[];
  logProgress: (message: string) => void;
}): Promise<{ reusedExistingBranch: boolean }> {
  input.logProgress(`Fetching PR target/base branch ${input.targetBranch} from origin.`);
  await runGit(input.repoRoot, ["fetch", "origin", `${input.targetBranch}:refs/remotes/origin/${input.targetBranch}`]);
  input.tools.push({
    method: "fetchBaseBranch",
    toolName: "git:fetch",
    calledAt: new Date().toISOString(),
    success: true,
  });

  if (input.reuseBranchIfPossible && await remoteBranchExists(input.repoRoot, input.branch)) {
    input.logProgress(`Reusing existing implementation branch ${input.branch} from origin.`);
    await runGit(input.repoRoot, ["fetch", "origin", `${input.branch}:refs/remotes/origin/${input.branch}`]);
    input.tools.push({
      method: "fetchExistingImplementationBranch",
      toolName: "git:fetch",
      calledAt: new Date().toISOString(),
      success: true,
    });

    if (await localBranchExists(input.repoRoot, input.branch)) {
      await runGit(input.repoRoot, ["checkout", input.branch]);
      input.logProgress(`Fast-forwarding local implementation branch ${input.branch} from origin/${input.branch}.`);
      await runGit(input.repoRoot, ["merge", "--ff-only", `origin/${input.branch}`]);
    } else {
      await runGit(input.repoRoot, ["checkout", "-b", input.branch, `origin/${input.branch}`]);
    }

    input.tools.push({
      method: "checkoutExistingImplementationBranch",
      toolName: "git:checkout",
      calledAt: new Date().toISOString(),
      success: true,
    });
    return { reusedExistingBranch: true };
  }

  input.logProgress(`Creating implementation branch ${input.branch} from origin/${input.targetBranch}.`);
  await runGit(input.repoRoot, ["checkout", "-b", input.branch, `origin/${input.targetBranch}`]);
  input.tools.push({
    method: "createImplementationBranch",
    toolName: "git:checkout",
    calledAt: new Date().toISOString(),
    success: true,
  });
  return { reusedExistingBranch: false };
}

export async function collectImplementationChangedFiles(input: {
  repoRoot: string;
  startingChangedFiles: string[];
  promptPath: string;
  extraExcludedPaths?: string[];
}): Promise<string[]> {
  return filterImplementationChangedFiles(
    parseGitChangedFiles(await gitStatusPorcelain(input.repoRoot)),
    input.startingChangedFiles,
    input.repoRoot,
    input.promptPath,
    input.extraExcludedPaths ?? [],
  );
}

export function filterImplementationChangedFiles(
  afterFiles: string[],
  startingFiles: string[],
  repoRoot: string,
  promptPath: string,
  extraExcludedPaths: string[] = [],
): string[] {
  const starting = new Set(startingFiles);
  const excluded = new Set([promptPath, ...extraExcludedPaths].map((path) => relativeGitPath(repoRoot, path)).filter((path): path is string => path !== undefined));
  return afterFiles.filter((file) => !starting.has(file) && !excluded.has(file));
}

export function buildCommandEnvironment(
  promptPath: string,
  issueKey: string,
  branch: string,
  targetBranch: string,
  healingPromptPath?: string,
): NodeJS.ProcessEnv {
  const inheritedSessionId = process.env.OTEL_SESSION_ID?.trim();
  return {
    ...process.env,
    MANSO_TEST_IMPLEMENTATION_PROMPT: promptPath,
    ...(healingPromptPath ? { MANSO_TEST_HEALING_PROMPT: healingPromptPath } : {}),
    MANSO_TEST_ISSUE: issueKey,
    MANSO_TEST_BRANCH: branch,
    MANSO_TEST_TARGET_BRANCH: targetBranch,
    OTEL_SESSION_ID: inheritedSessionId || `jira:${issueKey.toUpperCase()}`,
  };
}

export function relativeGitPath(repoRoot: string, path: string): string | undefined {
  const relativePath = relative(repoRoot, path).replace(/\\/g, "/");
  if (relativePath.startsWith("../") || relativePath === ".." || /^[A-Za-z]:\//.test(relativePath)) {
    return undefined;
  }

  return relativePath;
}

async function remoteBranchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await runGit(repoRoot, ["ls-remote", "--exit-code", "--heads", "origin", branch]);
    return true;
  } catch {
    return false;
  }
}

async function localBranchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await runGit(repoRoot, ["show-ref", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}
