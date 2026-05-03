#!/usr/bin/env node
import "dotenv/config";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import type { ToolProvenance, Warning } from "./domain/contextPack/schema.js";
import {
  XRAY_TEST_IMPLEMENTATION_SCHEMA_VERSION,
  XrayTestImplementationPackSchema,
} from "./domain/xrayTestImplementation/schema.js";
import type {
  XrayTestImplementationCommandResult,
  XrayTestImplementationGuidanceFile,
  XrayTestImplementationPack,
  XrayTestImplementationPullRequest,
} from "./domain/xrayTestImplementation/schema.js";
import { XrayTestGenerationPackSchema } from "./domain/xrayTestGeneration/schema.js";
import type { XrayTestGenerationPack } from "./domain/xrayTestGeneration/schema.js";
import { AzureDevOpsClient } from "./integrations/azureDevOps/client.js";
import {
  AzureDevOpsPullRequestCreator,
  resolveAzureDevOpsRepository,
} from "./integrations/azureDevOps/pullRequestCreator.js";
import {
  detectDefaultTargetBranch,
  gitCurrentHeadSha,
  gitCurrentRemoteUrl,
  gitStatusPorcelain,
  parseGitChangedFiles,
  runGit,
  runShellCommand,
} from "./integrations/git/localGit.js";
import { writeXrayTestImplementationPack } from "./output/xray-test-implementation/writer.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import {
  DEFAULT_REPO_GUIDANCE_PATHS,
  buildXrayTestImplementationPrompt,
} from "./workflows/xray-test-implementation/prompt.js";
import type { XrayTestImplementationGuidanceContent } from "./workflows/xray-test-implementation/prompt.js";

async function main(): Promise<void> {
  const args = parseCliArgs();
  const logProgress = createProgressLogger("implement-xray-tests");

  if (args.help) {
    printHelp();
    return;
  }

  const repoRoot = resolve(args.repoRoot);
  const xrayTestGenerationPath = resolveXrayTestGenerationPath(args);
  const outputDir = dirname(xrayTestGenerationPath);
  logProgress(`Loading Xray test generation pack from ${xrayTestGenerationPath}.`);
  const generation = XrayTestGenerationPackSchema.parse(JSON.parse(await readFile(xrayTestGenerationPath, "utf8")));

  const branch = normalizeBranchName(args.branch ?? defaultImplementationBranch(generation.ticket.key));
  const targetBranch = normalizeBranchName(args.targetBranch ?? process.env.SYSTEM_PULLREQUEST_TARGETBRANCH ?? (await detectDefaultTargetBranch(repoRoot)));
  if (branch === targetBranch) {
    throw new CliError(`Implementation branch must differ from the PR target/base branch (${targetBranch}).`);
  }
  const guidancePaths = args.guidancePaths.length > 0 ? args.guidancePaths : [...DEFAULT_REPO_GUIDANCE_PATHS];
  logProgress(`Loading ${guidancePaths.length} repository guidance file(s) from ${repoRoot}.`);
  const guidanceFiles = await readGuidanceFiles(repoRoot, guidancePaths);

  const prompt = buildXrayTestImplementationPrompt({
    generation,
    repoRoot,
    branch,
    targetBranch,
    guidanceFiles,
    sourceXrayTestGenerationPath: xrayTestGenerationPath,
    ...(args.verifyCommand ? { verifyCommand: args.verifyCommand } : {}),
  });
  const promptPath = resolvePromptPath(args, outputDir);
  const warnings: Warning[] = [];
  const tools: ToolProvenance[] = [];

  if (args.promptOnly || args.dryRun) {
    await writePrompt(promptPath, prompt, logProgress, tools);
    const pack = buildPack({
      generation,
      xrayTestGenerationPath,
      repoRoot,
      branch,
      targetBranch,
      promptPath,
      guidanceFiles,
      status: "prompt-only",
      changedFiles: [],
      pushed: false,
      pullRequest: {
        status: "skipped",
        warnings: [args.dryRun ? "Dry run mode; implementation command, git mutation, push, and PR creation were skipped." : "Prompt-only mode; implementation command, git mutation, push, and PR creation were skipped."],
      },
      tools,
      warnings,
    });
    const result = await writeXrayTestImplementationPack(pack, outputDir);
    console.log(`Wrote ${result.jsonPath}`);
    console.log(`Wrote ${result.markdownPath}`);
    console.log(`Wrote ${promptPath}`);
    return;
  }

  const agentCommand = args.agentCommand ?? process.env.MANSO_TEST_IMPLEMENTATION_COMMAND;
  if (!agentCommand) {
    throw new CliError("Missing --agent-command or MANSO_TEST_IMPLEMENTATION_COMMAND. Use --prompt-only to only write the LLM prompt.");
  }

  const startingChangedFiles = parseGitChangedFiles(await gitStatusPorcelain(repoRoot));
  if (!args.allowDirty) {
    if (startingChangedFiles.length > 0) {
      throw new CliError(`Refusing to implement tests with a dirty worktree. Commit, stash, or pass --allow-dirty. Current changes: ${startingChangedFiles.join(", ")}`);
    }
  }

  logProgress(`Fetching PR target/base branch ${targetBranch} from origin.`);
  await runGit(repoRoot, ["fetch", "origin", `${targetBranch}:refs/remotes/origin/${targetBranch}`]);
  tools.push({
    method: "fetchBaseBranch",
    toolName: "git:fetch",
    calledAt: new Date().toISOString(),
    success: true,
  });

  logProgress(`Creating implementation branch ${branch} from origin/${targetBranch}.`);
  await runGit(repoRoot, ["checkout", "-b", branch, `origin/${targetBranch}`]);
  tools.push({
    method: "createImplementationBranch",
    toolName: "git:checkout",
    calledAt: new Date().toISOString(),
    success: true,
  });

  await writePrompt(promptPath, prompt, logProgress, tools);

  logProgress("Running test implementation agent command. The implementation prompt is passed on stdin and through MANSO_TEST_IMPLEMENTATION_PROMPT.");
  const implementationCommand = await runCheckedShellCommand(agentCommand, repoRoot, buildCommandEnvironment(promptPath, generation.ticket.key, branch, targetBranch), prompt);
  tools.push({
    method: "runImplementationCommand",
    toolName: "shell:agent-command",
    calledAt: new Date().toISOString(),
    success: true,
  });

  let changedFiles = filterImplementationChangedFiles(
    parseGitChangedFiles(await gitStatusPorcelain(repoRoot)),
    startingChangedFiles,
    repoRoot,
    promptPath,
  );
  if (changedFiles.length === 0) {
    throw new CliError("Implementation command completed but did not leave any repository changes to commit.");
  }
  logProgress(`Implementation changed ${changedFiles.length} file(s).`);

  const verifyCommand = args.verifyCommand ?? process.env.MANSO_TEST_VERIFY_COMMAND;
  const verification = verifyCommand
    ? await runCheckedShellCommand(verifyCommand, repoRoot, buildCommandEnvironment(promptPath, generation.ticket.key, branch, targetBranch))
    : undefined;
  if (verification) {
    tools.push({
      method: "runVerificationCommand",
      toolName: "shell:verify-command",
      calledAt: new Date().toISOString(),
      success: true,
    });
  } else {
    warnings.push({
      section: "verification",
      toolName: "shell",
      message: "No verification command was provided. Set --verify-command or MANSO_TEST_VERIFY_COMMAND to run repository validation.",
    });
  }
  changedFiles = filterImplementationChangedFiles(
    parseGitChangedFiles(await gitStatusPorcelain(repoRoot)),
    startingChangedFiles,
    repoRoot,
    promptPath,
  );
  if (changedFiles.length === 0) {
    throw new CliError("No implementation changes remained after verification.");
  }

  logProgress("Committing implementation changes.");
  await runGit(repoRoot, ["add", "-A", "--", ...changedFiles]);
  const commitMessage = args.commitMessage ?? `${generation.ticket.key}: implement generated Xray tests`;
  await runGit(repoRoot, ["commit", "-m", commitMessage]);
  const commitSha = await gitCurrentHeadSha(repoRoot);
  tools.push({
    method: "commitImplementationChanges",
    toolName: "git:commit",
    calledAt: new Date().toISOString(),
    success: true,
  });

  logProgress(`Pushing implementation branch ${branch} to origin.`);
  await runGit(repoRoot, ["push", "-u", "origin", branch]);
  tools.push({
    method: "pushImplementationBranch",
    toolName: "git:push",
    calledAt: new Date().toISOString(),
    success: true,
  });

  const pullRequest = await createPullRequest({
    args,
    repoRoot,
    branch,
    targetBranch,
    title: args.prTitle ?? `${generation.ticket.key} Implement generated Xray tests`,
    description: args.prDescription ?? defaultPullRequestDescription(generation.ticket.key, promptPath, changedFiles, verification),
    tools,
    logProgress,
  });

  const pack = buildPack({
    generation,
    xrayTestGenerationPath,
    repoRoot,
    branch,
    targetBranch,
    promptPath,
    guidanceFiles,
    status: "completed",
    command: implementationCommand,
    ...(verification ? { verification } : {}),
    changedFiles,
    commitSha,
    pushed: true,
    pullRequest,
    tools,
    warnings,
  });
  const result = await writeXrayTestImplementationPack(pack, outputDir);

  console.log(`Wrote ${result.jsonPath}`);
  console.log(`Wrote ${result.markdownPath}`);
  if (pullRequest.url) {
    console.log(`Created PR ${pullRequest.url}`);
  }
  if (pack.warnings.length > 0) {
    console.warn(`Completed with ${pack.warnings.length} warning(s). See xray-test-implementation.json/xray-test-implementation.md.`);
  }
}

interface ParsedArgs {
  issue?: string;
  outDir: string;
  xrayTestGenerationPath?: string;
  repoRoot: string;
  guidancePaths: string[];
  promptPath?: string;
  agentCommand?: string;
  verifyCommand?: string;
  branch?: string;
  targetBranch?: string;
  commitMessage?: string;
  prTitle?: string;
  prDescription?: string;
  configPath?: string;
  promptOnly: boolean;
  dryRun: boolean;
  allowDirty: boolean;
  help: boolean;
}

function parseCliArgs(): ParsedArgs {
  const parsed = parseArgs({
    options: {
      issue: { type: "string" },
      out: { type: "string" },
      "xray-test-generation": { type: "string" },
      repo: { type: "string" },
      guidance: { type: "string", multiple: true },
      prompt: { type: "string" },
      "agent-command": { type: "string" },
      "verify-command": { type: "string" },
      branch: { type: "string" },
      "target-branch": { type: "string" },
      "commit-message": { type: "string" },
      "pr-title": { type: "string" },
      "pr-description": { type: "string" },
      config: { type: "string" },
      "prompt-only": { type: "boolean" },
      "dry-run": { type: "boolean" },
      "allow-dirty": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  return {
    ...(parsed.values.issue ? { issue: parsed.values.issue } : {}),
    outDir: parsed.values.out ?? "./out",
    ...(parsed.values["xray-test-generation"] ? { xrayTestGenerationPath: parsed.values["xray-test-generation"] } : {}),
    repoRoot: parsed.values.repo ?? process.cwd(),
    guidancePaths: parsed.values.guidance ?? [],
    ...(parsed.values.prompt ? { promptPath: parsed.values.prompt } : {}),
    ...(parsed.values["agent-command"] ? { agentCommand: parsed.values["agent-command"] } : {}),
    ...(parsed.values["verify-command"] ? { verifyCommand: parsed.values["verify-command"] } : {}),
    ...(parsed.values.branch ? { branch: parsed.values.branch } : {}),
    ...(parsed.values["target-branch"] ? { targetBranch: parsed.values["target-branch"] } : {}),
    ...(parsed.values["commit-message"] ? { commitMessage: parsed.values["commit-message"] } : {}),
    ...(parsed.values["pr-title"] ? { prTitle: parsed.values["pr-title"] } : {}),
    ...(parsed.values["pr-description"] ? { prDescription: parsed.values["pr-description"] } : {}),
    ...(parsed.values.config ? { configPath: parsed.values.config } : {}),
    promptOnly: parsed.values["prompt-only"] ?? false,
    dryRun: parsed.values["dry-run"] ?? false,
    allowDirty: parsed.values["allow-dirty"] ?? false,
    help: parsed.values.help ?? false,
  };
}

function resolveXrayTestGenerationPath(args: ParsedArgs): string {
  if (args.xrayTestGenerationPath) {
    return resolve(args.xrayTestGenerationPath);
  }

  if (!args.issue) {
    throw new CliError("Missing --xray-test-generation or --issue value.");
  }

  return resolve(join(args.outDir, args.issue, "xray-test-generation.json"));
}

function resolvePromptPath(args: ParsedArgs, outputDir: string): string {
  return resolve(args.promptPath ?? join(outputDir, "xray-test-implementation-prompt.md"));
}

async function readGuidanceFiles(repoRoot: string, paths: string[]): Promise<XrayTestImplementationGuidanceContent[]> {
  const files: XrayTestImplementationGuidanceContent[] = [];
  for (const path of paths) {
    const fullPath = resolve(repoRoot, path);
    try {
      await access(fullPath);
    } catch {
      throw new CliError(`Required repository guidance file was not found: ${path}`);
    }

    files.push({ path, content: await readFile(fullPath, "utf8") });
  }

  return files;
}

async function writePrompt(
  promptPath: string,
  prompt: string,
  logProgress: (message: string) => void,
  tools: ToolProvenance[],
): Promise<void> {
  await mkdir(dirname(promptPath), { recursive: true });
  await writeFile(promptPath, prompt, "utf8");
  logProgress(`Wrote implementation prompt to ${promptPath}.`);
  tools.push({
    method: "writeImplementationPrompt",
    toolName: "file:write",
    calledAt: new Date().toISOString(),
    success: true,
  });
}

function filterImplementationChangedFiles(afterFiles: string[], startingFiles: string[], repoRoot: string, promptPath: string): string[] {
  const starting = new Set(startingFiles);
  const promptRelativePath = relativeGitPath(repoRoot, promptPath);
  return afterFiles.filter((file) => !starting.has(file) && file !== promptRelativePath);
}

function relativeGitPath(repoRoot: string, path: string): string | undefined {
  const relativePath = relative(repoRoot, path).replace(/\\/g, "/");
  if (relativePath.startsWith("../") || relativePath === ".." || /^[A-Za-z]:\//.test(relativePath)) {
    return undefined;
  }

  return relativePath;
}

function buildCommandEnvironment(promptPath: string, issueKey: string, branch: string, targetBranch: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MANSO_TEST_IMPLEMENTATION_PROMPT: promptPath,
    MANSO_TEST_ISSUE: issueKey,
    MANSO_TEST_BRANCH: branch,
    MANSO_TEST_TARGET_BRANCH: targetBranch,
  };
}

async function runCheckedShellCommand(
  command: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<XrayTestImplementationCommandResult> {
  const result = await runShellCommand(command, repoRoot, env, stdin);
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed with exit code ${result.exitCode}.`);
  }

  return {
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
}

interface CreatePullRequestOptions {
  args: ParsedArgs;
  repoRoot: string;
  branch: string;
  targetBranch: string;
  title: string;
  description: string;
  tools: ToolProvenance[];
  logProgress: (message: string) => void;
}

async function createPullRequest(options: CreatePullRequestOptions): Promise<XrayTestImplementationPullRequest> {
  options.logProgress("Creating Azure DevOps pull request.");
  const config = await loadRuntimeConfig({
    ...(options.args.configPath ? { configPath: options.args.configPath } : {}),
  });
  if (!config.azureDevOps) {
    throw new CliError("Missing Azure DevOps token for required PR creation. Set AZURE_DEVOPS_PAT, AZURE_DEVOPS_TOKEN, or SYSTEM_ACCESSTOKEN.");
  }

  const remoteUrl = await gitCurrentRemoteUrl(options.repoRoot);
  const repository = resolveAzureDevOpsRepository(remoteUrl);
  if (!repository) {
    throw new CliError(`Could not resolve Azure DevOps repository from origin remote ${remoteUrl}.`);
  }

  const creator = new AzureDevOpsPullRequestCreator(new AzureDevOpsClient({ token: config.azureDevOps.token }));
  const created = await creator.create({
    repository,
    sourceBranch: options.branch,
    targetBranch: options.targetBranch,
    title: options.title,
    description: options.description,
  });
  options.tools.push({
    method: "createPullRequest",
    toolName: "azure-devops:pullrequests",
    calledAt: new Date().toISOString(),
    success: true,
  });

  return {
    status: "created",
    provider: "azure-devops",
    id: created.id,
    url: created.url,
    title: options.title,
    sourceBranch: options.branch,
    targetBranch: options.targetBranch,
    warnings: [],
  };
}

interface BuildPackInput {
  generation: XrayTestGenerationPack;
  xrayTestGenerationPath: string;
  repoRoot: string;
  branch: string;
  targetBranch: string;
  promptPath: string;
  guidanceFiles: XrayTestImplementationGuidanceContent[];
  status: "prompt-only" | "completed";
  command?: XrayTestImplementationCommandResult;
  verification?: XrayTestImplementationCommandResult;
  changedFiles: string[];
  commitSha?: string;
  pushed: boolean;
  pullRequest: XrayTestImplementationPullRequest;
  tools: ToolProvenance[];
  warnings: Warning[];
}

function buildPack(input: BuildPackInput): XrayTestImplementationPack {
  const guidanceFiles: XrayTestImplementationGuidanceFile[] = input.guidanceFiles.map((file) => ({
    path: file.path,
    bytes: Buffer.byteLength(file.content, "utf8"),
  }));
  const pack: XrayTestImplementationPack = {
    schemaVersion: XRAY_TEST_IMPLEMENTATION_SCHEMA_VERSION,
    ticket: {
      key: input.generation.ticket.key,
      title: input.generation.ticket.title,
      ...(input.generation.ticket.url ? { url: input.generation.ticket.url } : {}),
    },
    implementation: {
      status: input.status,
      repoRoot: input.repoRoot,
      branch: input.branch,
      targetBranch: input.targetBranch,
      promptPath: input.promptPath,
      guidanceFiles,
      ...(input.command ? { command: input.command } : {}),
      ...(input.verification ? { verification: input.verification } : {}),
      changedFiles: input.changedFiles,
      ...(input.commitSha ? { commitSha: input.commitSha } : {}),
      pushed: input.pushed,
    },
    pullRequest: input.pullRequest,
    provenance: {
      generatedAt: new Date().toISOString(),
      sourceXrayTestGenerationPath: input.xrayTestGenerationPath,
      tools: input.tools,
    },
    warnings: input.warnings,
  };

  return XrayTestImplementationPackSchema.parse(pack);
}

function defaultPullRequestDescription(
  issueKey: string,
  promptPath: string,
  changedFiles: string[],
  verification: XrayTestImplementationCommandResult | undefined,
): string {
  const lines = [
    `Implements automated tests for generated Xray test cases from ${issueKey}.`,
    "",
    `Prompt source: ${promptPath}`,
    "",
    "Changed files:",
    ...changedFiles.map((file) => `- ${file}`),
    "",
    verification
      ? `Verification: ${verification.command} completed with exit code ${verification.exitCode}.`
      : "Verification: no verification command was provided.",
  ];

  return lines.join("\n");
}

function defaultImplementationBranch(issueKey: string): string {
  return `tests/${issueKey.toLowerCase()}-xray-implementation`
    .replace(/[^a-z0-9/_-]+/gi, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "");
}

function normalizeBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, "");
}

function printHelp(): void {
  console.log(`Xray Test Implementation

Usage:
  implement-xray-tests --issue ABC-123 --out ./out --agent-command "codex exec -"
  implement-xray-tests --xray-test-generation ./out/ABC-123/xray-test-generation.json --prompt-only

Options:
  --issue <key>                    Jira issue key whose ./out/<key>/xray-test-generation.json should be used.
  --out <dir>                      Output root directory. Defaults to ./out.
  --xray-test-generation <path>    Explicit xray-test-generation.json path.
  --repo <dir>                     Repository root to edit. Defaults to the current working directory.
  --guidance <path>                Guidance file relative to repo root. May be repeated.
                                   Defaults to architecture/test-architecture.md,
                                   docs/testing/ai-test-generation.md,
                                   .manso/testgen.md, and .manso/repo-conventions.json.
  --prompt <path>                  Prompt output path. Defaults next to xray-test-generation.json.
  --agent-command <command>        Shell command that implements tests. Prompt is sent on stdin and
                                   MANSO_TEST_IMPLEMENTATION_PROMPT points to the prompt file.
  --verify-command <command>       Optional shell validation command to run before committing.
  --branch <name>                  Implementation branch. Defaults to tests/<issue>-xray-implementation.
  --target-branch <name>           PR target branch. Defaults to origin HEAD or main.
  --commit-message <message>       Commit message.
  --pr-title <title>               Pull request title.
  --pr-description <text>          Pull request description.
  --config <path>                  Optional JSON config for non-secret overrides.
  --prompt-only                    Write the LLM prompt and output pack without editing git.
  --dry-run                        Alias for prompt-only with dry-run wording.
  --allow-dirty                    Allow starting with a dirty worktree.
  -h, --help                       Show this help.
`);
}

class CliError extends Error {}

main().catch((error: unknown) => {
  if (error instanceof CliError) {
    console.error(error.message);
  } else if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }

  process.exitCode = 1;
});
