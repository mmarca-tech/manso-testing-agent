import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { AzureDevOpsClient } from "../integrations/azureDevOps/client.js";
import {
  AzureDevOpsPullRequestCreator,
  type CreatedAzureDevOpsPullRequest,
  resolveAzureDevOpsRepositoryFromRemote,
} from "../integrations/azureDevOps/pullRequestCreator.js";

export const MANSO_MEMORY_ROOT_ENV = "MANSO_MEMORY_ROOT";
export const MANSO_MEMORY_ENABLED_ENV = "MANSO_MEMORY_ENABLED";
export const MANSO_MEMORY_STRICT_ENV = "MANSO_MEMORY_STRICT";
export const MANSO_MEMORY_CACHE_DIR_ENV = "MANSO_MEMORY_CACHE_DIR";
export const MANSO_MEMORY_BRANCH_ENV = "MANSO_MEMORY_BRANCH";
export const JUANA_PERSONA_MEMORY_PATH = join("persona", "juana-manso.md");

export type MemoryArtifactKind = "json" | "markdown";

export interface MemoryArtifactFile {
  path: string;
  kind: MemoryArtifactKind;
}

export interface MemoryScope {
  type: "jira" | "pull-request" | "misc";
  id: string;
}

export interface MirrorMemoryArtifactsOptions {
  workflow: string;
  directory: string;
  files: MemoryArtifactFile[];
  scope?: MemoryScope;
}

export interface MirrorMemoryArtifactsResult {
  root: string;
  latestDirectory: string;
  runDirectory: string;
  latestManifestPath: string;
  runManifestPath: string;
}

export async function mirrorArtifactSetToMemory(
  options: MirrorMemoryArtifactsOptions,
): Promise<MirrorMemoryArtifactsResult | undefined> {
  try {
    const root = ensureMansoMemoryRoot();
    if (!root) {
      return undefined;
    }

    return await writeArtifactSetToMemory(root, options);
  } catch (error) {
    if (parseBoolean(process.env[MANSO_MEMORY_STRICT_ENV], false)) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[manso-memory] Could not mirror ${options.workflow} artifacts: ${message}`);
    return undefined;
  }
}

export async function mirrorFileToMemory(options: {
  workflow: string;
  path: string;
  scope: MemoryScope;
  kind: MemoryArtifactKind;
}): Promise<MirrorMemoryArtifactsResult | undefined> {
  return mirrorArtifactSetToMemory({
    workflow: options.workflow,
    directory: dirname(resolve(options.path)),
    scope: options.scope,
    files: [{ path: options.path, kind: options.kind }],
  });
}

export function loadJuanaPersonaFromMemory(fallback: string): string {
  const root = safeEnsureMansoMemoryRootForRead();
  if (!root) {
    return fallback;
  }

  const personaPath = join(root, JUANA_PERSONA_MEMORY_PATH);
  if (!existsSync(personaPath)) {
    return fallback;
  }

  try {
    const persona = readFileSync(personaPath, "utf8").trim();
    return persona.length > 0 ? persona : fallback;
  } catch {
    return fallback;
  }
}

export function resolveMansoMemoryRoot(): string | undefined {
  if (!parseBoolean(process.env[MANSO_MEMORY_ENABLED_ENV], true)) {
    return undefined;
  }

  const configuredRoot = nonEmpty(process.env[MANSO_MEMORY_ROOT_ENV]);
  if (!configuredRoot) {
    return undefined;
  }

  return isGitRemoteUrl(configuredRoot)
    ? resolveMemoryClonePath(configuredRoot)
    : resolve(configuredRoot);
}

export function ensureMansoMemoryRoot(options: { quiet?: boolean } = {}): string | undefined {
  const root = resolveMansoMemoryRoot();
  if (!root) {
    return undefined;
  }

  const configuredRoot = nonEmpty(process.env[MANSO_MEMORY_ROOT_ENV]);
  if (!configuredRoot || !isGitRemoteUrl(configuredRoot)) {
    return root;
  }

  ensureMemoryGitClone(configuredRoot, root, options);
  return root;
}

export function isGitRemoteUrl(value: string): boolean {
  return /^(https?|ssh|file):\/\//iu.test(value)
    || /^git@[^:]+:.+/iu.test(value)
    || /^.+@[^:]+:.+\.git$/iu.test(value);
}

export function inferMemoryScopeFromDirectory(directory: string): MemoryScope {
  const id = basename(resolve(directory));
  if (/^[A-Z][A-Z0-9]+-\d+$/u.test(id)) {
    return { type: "jira", id };
  }

  if (/^pr-\d+$/iu.test(id)) {
    return { type: "pull-request", id: id.toLowerCase() };
  }

  return { type: "misc", id: sanitizePathSegment(id || "unknown") };
}

async function writeArtifactSetToMemory(
  root: string,
  options: MirrorMemoryArtifactsOptions,
): Promise<MirrorMemoryArtifactsResult> {
  const scope = options.scope ?? inferMemoryScopeFromDirectory(options.directory);
  const gitContext = prepareMemoryGitWriteContext(root, scope);
  const timestamp = toPathTimestamp(new Date());
  const scopeDirectory = join(root, "artifacts", scope.type, sanitizePathSegment(scope.id));
  const latestDirectory = join(scopeDirectory, "latest");
  const runDirectory = join(scopeDirectory, "runs", `${timestamp}-${sanitizePathSegment(options.workflow)}`);

  await mkdir(latestDirectory, { recursive: true });
  await mkdir(runDirectory, { recursive: true });

  const files = [];
  for (const file of options.files) {
    const name = basename(file.path);
    const latestPath = join(latestDirectory, name);
    const runPath = join(runDirectory, name);
    await copyFile(file.path, latestPath);
    await copyFile(file.path, runPath);
    files.push({
      name,
      kind: file.kind,
      sourcePath: resolve(file.path),
      latestPath,
      runPath,
    });
  }

  const manifest = {
    schemaVersion: "1.0.0",
    updatedAt: new Date().toISOString(),
    workflow: options.workflow,
    scope,
    sourceDirectory: resolve(options.directory),
    files,
  };
  const latestManifestPath = join(latestDirectory, "manifest.json");
  const runManifestPath = join(runDirectory, "manifest.json");
  const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(latestManifestPath, serializedManifest, "utf8");
  await writeFile(runManifestPath, serializedManifest, "utf8");
  await commitMemoryArtifactSet(root, options.workflow, scope, [latestDirectory, runDirectory], gitContext);

  return {
    root,
    latestDirectory,
    runDirectory,
    latestManifestPath,
    runManifestPath,
  };
}

function toPathTimestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, "-");
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

interface MemoryGitWriteContext {
  remote?: string;
  targetBranch?: string;
  fallbackBranch?: string;
  usingFallbackBranch: boolean;
}

function prepareMemoryGitWriteContext(root: string, scope: MemoryScope): MemoryGitWriteContext {
  if (!existsSync(join(root, ".git"))) {
    return { usingFallbackBranch: false };
  }

  const remote = firstGitRemote(root);
  const fallbackBranch = buildMemoryPullRequestBranch(scope);
  const currentBranch = currentGitBranch(root);
  const configuredTargetBranch = nonEmpty(process.env[MANSO_MEMORY_BRANCH_ENV]);
  const targetBranch = configuredTargetBranch
    ?? (currentBranch !== fallbackBranch ? currentBranch : undefined)
    ?? (remote ? defaultRemoteBranch(root, remote) : undefined);
  if (!remote) {
    return {
      ...(targetBranch ? { targetBranch } : {}),
      fallbackBranch,
      usingFallbackBranch: currentBranch === fallbackBranch,
    };
  }

  if (currentBranch !== fallbackBranch && remoteBranchExists(root, remote, fallbackBranch)) {
    checkoutRemoteBranch(root, remote, fallbackBranch);
    return {
      ...(targetBranch ? { targetBranch } : {}),
      remote,
      fallbackBranch,
      usingFallbackBranch: true,
    };
  }

  return {
    ...(targetBranch ? { targetBranch } : {}),
    remote,
    fallbackBranch,
    usingFallbackBranch: currentBranch === fallbackBranch,
  };
}

async function commitMemoryArtifactSet(
  root: string,
  workflow: string,
  scope: MemoryScope,
  paths: string[],
  context: MemoryGitWriteContext,
): Promise<void> {
  if (!existsSync(join(root, ".git"))) {
    return;
  }

  const relativePaths = paths.map((path) => toGitPath(relative(root, path)));
  runGit(["add", "--", ...relativePaths], root, {});
  if (isGitIndexCleanForPaths(root, relativePaths)) {
    return;
  }

  ensureMemoryGitIdentity(root);
  const message = `Store ${workflow} artifacts for ${scope.id}`;
  runGit(["commit", "-m", message, "--", ...relativePaths], root, {});
  const commitSha = gitOutput(["rev-parse", "--short", "HEAD"], root, { quiet: true }).trim();
  const pushResult = await pushMemoryChanges(root, workflow, scope, context);
  console.log(`[manso-memory] Committed ${workflow} artifacts for ${scope.id} to memory cabin (${commitSha}${formatMemoryPushResult(pushResult)}).`);
}

function isGitIndexCleanForPaths(cwd: string, paths: string[]): boolean {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet", "--", ...paths], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch (error) {
    if (isExitStatus(error, 1)) {
      return false;
    }

    throw error;
  }
}

function ensureMemoryGitIdentity(cwd: string): void {
  if (!gitConfigValue(cwd, "user.email")) {
    runGit(["config", "user.email", "manso-testing-agent@org.com"], cwd, { quiet: true });
  }

  if (!gitConfigValue(cwd, "user.name")) {
    runGit(["config", "user.name", "Manso Testing Agent"], cwd, { quiet: true });
  }
}

function gitConfigValue(cwd: string, key: string): string | undefined {
  try {
    const value = gitOutput(["config", "--get", key], cwd, { quiet: true }).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

interface MemoryPushResult {
  pushed: boolean;
  pullRequest?: CreatedAzureDevOpsPullRequest;
}

async function pushMemoryChanges(
  cwd: string,
  workflow: string,
  scope: MemoryScope,
  context: MemoryGitWriteContext,
): Promise<MemoryPushResult> {
  const remote = context.remote ?? firstGitRemote(cwd);
  if (!remote) {
    return { pushed: false };
  }

  const branch = currentGitBranch(cwd);
  if (branch.length === 0) {
    return { pushed: false };
  }

  const targetBranch = context.targetBranch ?? branch;
  const fallbackBranch = context.fallbackBranch ?? buildMemoryPullRequestBranch(scope);
  if (context.usingFallbackBranch || branch === fallbackBranch) {
    pushMemoryBranch(cwd, remote, fallbackBranch);
    const pullRequest = await ensureMemoryPullRequest(cwd, remote, fallbackBranch, targetBranch, workflow, scope);
    return {
      pushed: true,
      ...(pullRequest ? { pullRequest } : {}),
    };
  }

  try {
    pushCurrentBranch(cwd, remote, branch);
    return { pushed: true };
  } catch (error) {
    console.warn(`[manso-memory] Direct push to ${branch} failed; creating a memory pull request branch. ${errorMessage(error)}`);
  }

  runGit(["checkout", "-B", fallbackBranch], cwd, {});
  pushMemoryBranch(cwd, remote, fallbackBranch);
  resetLocalBranchToRemote(cwd, remote, targetBranch);
  const pullRequest = await ensureMemoryPullRequest(cwd, remote, fallbackBranch, targetBranch, workflow, scope);
  return {
    pushed: true,
    ...(pullRequest ? { pullRequest } : {}),
  };
}

function pushCurrentBranch(cwd: string, remote: string, branch: string): void {
  const pushArgs = gitHasUpstream(cwd)
    ? ["push"]
    : ["push", "-u", remote, branch];

  try {
    runGit(pushArgs, cwd, {});
  } catch (error) {
    try {
      runGit(["pull", "--rebase"], cwd, {});
      runGit(pushArgs, cwd, {});
    } catch {
      throw error;
    }
  }
}

function pushMemoryBranch(cwd: string, remote: string, branch: string): void {
  try {
    runGit(["push", "-u", remote, `HEAD:refs/heads/${branch}`], cwd, {});
  } catch (error) {
    try {
      runGit(["pull", "--rebase", remote, branch], cwd, {});
      runGit(["push", "-u", remote, `HEAD:refs/heads/${branch}`], cwd, {});
    } catch {
      throw error;
    }
  }
}

async function ensureMemoryPullRequest(
  cwd: string,
  remote: string,
  sourceBranch: string,
  targetBranch: string,
  workflow: string,
  scope: MemoryScope,
): Promise<CreatedAzureDevOpsPullRequest | undefined> {
  const configuredRoot = nonEmpty(process.env[MANSO_MEMORY_ROOT_ENV]);
  const remoteUrl = configuredRoot && isGitRemoteUrl(configuredRoot)
    ? configuredRoot
    : gitOutput(["remote", "get-url", remote], cwd, { quiet: true }).trim();
  const repository = resolveAzureDevOpsRepositoryFromRemote(remoteUrl);
  if (!repository) {
    handleMemoryPullRequestFailure(new Error(`Memory remote is not an Azure DevOps repository URL: ${remoteUrl}`));
    return undefined;
  }

  const token = nonEmpty(process.env.AZURE_DEVOPS_PAT)
    ?? nonEmpty(process.env.AZURE_DEVOPS_TOKEN)
    ?? nonEmpty(process.env.SYSTEM_ACCESSTOKEN);
  if (!token) {
    handleMemoryPullRequestFailure(new Error("Missing Azure DevOps token. Set AZURE_DEVOPS_PAT, AZURE_DEVOPS_TOKEN, or SYSTEM_ACCESSTOKEN."));
    return undefined;
  }

  try {
    const creator = new AzureDevOpsPullRequestCreator(new AzureDevOpsClient({ token }));
    const existing = await creator.findActive({
      repository,
      sourceBranch,
      targetBranch,
    });
    if (existing) {
      console.log(`[manso-memory] Updated existing memory pull request ${existing.url}.`);
      return existing;
    }

    const created = await creator.create({
      repository,
      sourceBranch,
      targetBranch,
      title: `Update Juana Manso memory for ${scope.id}`,
      description: [
        `Automated memory-cabin update generated by manso-testing-agent.`,
        "",
        `- Scope: ${scope.type}/${scope.id}`,
        `- Workflow: ${workflow}`,
        `- Target branch: ${targetBranch}`,
      ].join("\n"),
    });
    console.log(`[manso-memory] Created memory pull request ${created.url}.`);
    return created;
  } catch (error) {
    handleMemoryPullRequestFailure(error);
    return undefined;
  }
}

function firstGitRemote(cwd: string): string | undefined {
  const remotes = gitOutput(["remote"], cwd, { quiet: true })
    .split(/\r?\n/u)
    .map((remote) => remote.trim())
    .filter((remote) => remote.length > 0);
  return remotes[0];
}

function currentGitBranch(cwd: string): string {
  return gitOutput(["branch", "--show-current"], cwd, { quiet: true }).trim();
}

function defaultRemoteBranch(cwd: string, remote: string): string | undefined {
  try {
    const symbolicRef = gitOutput(["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], cwd, { quiet: true }).trim();
    const prefix = `${remote}/`;
    return symbolicRef.startsWith(prefix) ? symbolicRef.slice(prefix.length) : symbolicRef;
  } catch {
    return undefined;
  }
}

function gitHasUpstream(cwd: string): boolean {
  try {
    return gitOutput(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd, { quiet: true }).trim().length > 0;
  } catch {
    return false;
  }
}

function remoteBranchExists(cwd: string, remote: string, branch: string): boolean {
  try {
    execFileSync("git", ["ls-remote", "--exit-code", "--heads", remote, branch], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function checkoutRemoteBranch(cwd: string, remote: string, branch: string): void {
  runGit(["fetch", remote, branch], cwd, {});
  runGit(["checkout", "-B", branch, "FETCH_HEAD"], cwd, {});
}

function resetLocalBranchToRemote(cwd: string, remote: string, branch: string): void {
  try {
    runGit(["fetch", remote, branch], cwd, { quiet: true });
    runGit(["branch", "-f", branch, "FETCH_HEAD"], cwd, { quiet: true });
  } catch (error) {
    console.warn(`[manso-memory] Could not reset local memory target branch ${branch}: ${errorMessage(error)}`);
  }
}

function buildMemoryPullRequestBranch(scope: MemoryScope): string {
  return `manso-memory/${sanitizeGitBranchSegment(scope.type)}/${sanitizeGitBranchSegment(scope.id)}`;
}

function sanitizeGitBranchSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/\.\.+/gu, ".")
    .replace(/\.lock$/u, "-lock");
  return sanitized.length > 0 ? sanitized : "unknown";
}

function formatMemoryPushResult(result: MemoryPushResult): string {
  if (result.pullRequest) {
    return `, pushed via PR ${result.pullRequest.url}`;
  }

  return result.pushed ? ", pushed" : "";
}

function handleMemoryPullRequestFailure(error: unknown): void {
  if (parseBoolean(process.env[MANSO_MEMORY_STRICT_ENV], false)) {
    throw error;
  }

  console.warn(`[manso-memory] Memory branch was pushed, but pull request creation failed: ${errorMessage(error)}`);
}

function toGitPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function resolveMemoryClonePath(remoteUrl: string): string {
  const configuredCacheDir = nonEmpty(process.env[MANSO_MEMORY_CACHE_DIR_ENV]);
  const cacheRoot = configuredCacheDir
    ? resolve(configuredCacheDir)
    : join(homedir(), ".manso", "memory-cabins");
  const remoteName = remoteUrl
    .replace(/[?#].*$/u, "")
    .replace(/\/+$/u, "")
    .split(/[/:\\]/u)
    .filter(Boolean)
    .at(-1)
    ?.replace(/\.git$/iu, "") ?? "memory-cabin";
  const hash = createHash("sha256").update(remoteUrl).digest("hex").slice(0, 12);

  return join(cacheRoot, `${sanitizePathSegment(remoteName)}-${hash}`);
}

function ensureMemoryGitClone(remoteUrl: string, localPath: string, options: { quiet?: boolean }): void {
  const branch = nonEmpty(process.env[MANSO_MEMORY_BRANCH_ENV]);
  if (!existsSync(localPath)) {
    mkdirSync(dirname(localPath), { recursive: true });
    const cloneArgs = [
      "clone",
      ...(branch ? ["--branch", branch] : []),
      remoteUrl,
      localPath,
    ];
    runGit(cloneArgs, undefined, options);
    return;
  }

  if (!existsSync(join(localPath, ".git"))) {
    throw new Error(`Memory clone path exists but is not a Git repository: ${localPath}`);
  }

  if (!isGitWorktreeClean(localPath)) {
    return;
  }

  try {
    runGit(["fetch", "--prune"], localPath, options);
  } catch (error) {
    warnGitRefreshFailure("fetch", localPath, error, options);
    return;
  }

  const currentBranch = gitOutput(["branch", "--show-current"], localPath, options).trim();
  const branchToPull = branch ?? currentBranch;
  if (branchToPull.length === 0) {
    return;
  }

  if (branch && branch !== currentBranch) {
    runGit(["checkout", branch], localPath, options);
  }
  try {
    runGit(["pull", "--ff-only"], localPath, options);
  } catch (error) {
    warnGitRefreshFailure("pull", localPath, error, options);
  }
}

function safeEnsureMansoMemoryRootForRead(): string | undefined {
  try {
    return ensureMansoMemoryRoot({ quiet: true });
  } catch {
    return undefined;
  }
}

function isGitWorktreeClean(cwd: string): boolean {
  return gitOutput(["status", "--porcelain"], cwd, { quiet: true }).trim().length === 0;
}

function runGit(args: string[], cwd: string | undefined, options: { quiet?: boolean }): void {
  execFileSync("git", args, {
    cwd,
    stdio: options.quiet ? "ignore" : ["ignore", "ignore", "inherit"],
  });
}

function gitOutput(args: string[], cwd: string, options: { quiet?: boolean }): string {
  return execFileSync("git", args, {
    cwd,
    stdio: options.quiet ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
}

function warnGitRefreshFailure(operation: string, localPath: string, error: unknown, options: { quiet?: boolean }): void {
  if (options.quiet) {
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[manso-memory] Could not ${operation} memory clone at ${localPath}; using existing clone. ${message}`);
}

function isExitStatus(error: unknown, status: number): boolean {
  return typeof error === "object"
    && error !== null
    && "status" in error
    && (error as { status?: unknown }).status === status;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}
