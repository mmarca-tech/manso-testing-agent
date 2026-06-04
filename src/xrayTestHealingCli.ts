#!/usr/bin/env node
import "dotenv/config";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import {
  gitCurrentBranch,
  gitStatusPorcelain,
  parseGitChangedFiles,
} from "./integrations/git/localGit.js";
import { flushTelemetry } from "./integrations/llm/telemetry/observability.js";
import { CliError, rejectInternalCliEntrypoint } from "./shared/cli.js";
import { asString, coerceStringOptionValues, parseNonNegativeInteger } from "./shared/cliArgs.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import { resolveImplementationAgentRunners } from "./workflows/xray-test-implementation/agentRunner.js";
import {
  buildCommandEnvironment,
  relativeGitPath,
  resolveTargetBranch,
} from "./workflows/xray-test-implementation/implementationGit.js";
import {
  runShellCommandResult,
  runVerificationHealingLoop,
} from "./workflows/xray-test-implementation/verificationHealing.js";

async function main(): Promise<void> {
  const args = parseCliArgs();
  const logProgress = createProgressLogger("heal-xray-tests");

  if (args.help) {
    printHelp();
    return;
  }

  try {
    await runXrayTestHealing(args, logProgress);
  } finally {
    await flushTelemetry();
  }
}

export async function runXrayTestHealing(args: ParsedArgs, logProgress = createProgressLogger("heal-xray-tests")): Promise<void> {
  const repoRoot = resolve(args.repoRoot);
  const issueKey = args.issue?.toUpperCase() ?? "UNKNOWN";
  const promptPath = resolvePromptPath(args, args.issue?.toUpperCase());
  const verifyCommand = args.verifyCommand ?? nonEmpty(process.env.MANSO_TEST_VERIFY_COMMAND);
  if (!verifyCommand) {
    throw new CliError("Missing --verify-command or MANSO_TEST_VERIFY_COMMAND.");
  }

  const config = await loadRuntimeConfig();
  const agents = resolveImplementationAgentRunners(args, config);

  await assertFileExists(promptPath);
  const branch = args.branch ?? await gitCurrentBranch(repoRoot);
  const targetBranch = await resolveTargetBranch(repoRoot, args.targetBranch);
  const verification = await runShellCommandResult(
    verifyCommand,
    repoRoot,
    buildCommandEnvironment(promptPath, issueKey, branch, targetBranch),
    undefined,
    true,
  );
  if (verification.exitCode === 0) {
    logProgress(`Verification already passes: ${verifyCommand}.`);
    return;
  }

  const result = await runVerificationHealingLoop({
    issueKey,
    repoRoot,
    branch,
    targetBranch,
    promptPath,
    outputDir: dirname(promptPath),
    verifyCommand,
    healAgentRunner: agents.healing,
    ...(config.observability?.telemetry ? { telemetry: config.observability.telemetry } : {}),
    maxHealAttempts: args.healAttempts,
    initialVerification: verification,
    getChangedFiles: (healingPromptPaths) => collectChangedFiles(repoRoot, [promptPath, ...healingPromptPaths]),
    logProgress,
  });
  if (!result.passed) {
    throw new CliError(result.failureMessage ?? `Verification failed after ${args.healAttempts} healing attempt(s).`);
  }

  logProgress(`Verification passed after ${result.healingAttempts.length} healing attempt(s).`);
}

export interface ParsedArgs {
  issue?: string;
  outDir: string;
  repoRoot: string;
  promptPath?: string;
  agentCommand?: string;
  healAgentCommand?: string;
  agentPath?: string;
  agentArguments?: string;
  healAttempts: number;
  verifyCommand?: string;
  branch?: string;
  targetBranch?: string;
  help: boolean;
}

function parseCliArgs(): ParsedArgs {
  const parsed = parseArgs({
    args: coerceStringOptionValues(process.argv.slice(2), ["agent-arguments"]),
    options: {
      issue: { type: "string" },
      out: { type: "string" },
      repo: { type: "string" },
      prompt: { type: "string" },
      "agent-command": { type: "string" },
      "heal-agent-command": { type: "string" },
      "agent-path": { type: "string" },
      "agent-arguments": { type: "string" },
      "heal-attempts": { type: "string" },
      "verify-command": { type: "string" },
      branch: { type: "string" },
      "target-branch": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  const issue = asString(parsed.values.issue);
  const promptPath = asString(parsed.values.prompt);
  const agentCommand = asString(parsed.values["agent-command"]);
  const healAgentCommand = asString(parsed.values["heal-agent-command"]);
  const agentPath = asString(parsed.values["agent-path"]);
  const agentArguments = asString(parsed.values["agent-arguments"]);
  const verifyCommand = asString(parsed.values["verify-command"]);
  const branch = asString(parsed.values.branch);
  const targetBranch = asString(parsed.values["target-branch"]);

  return {
    ...(issue ? { issue } : {}),
    outDir: asString(parsed.values.out) ?? "./out",
    repoRoot: asString(parsed.values.repo) ?? process.cwd(),
    ...(promptPath ? { promptPath } : {}),
    ...(agentCommand ? { agentCommand } : {}),
    ...(healAgentCommand ? { healAgentCommand } : {}),
    ...(agentPath ? { agentPath } : {}),
    ...(agentArguments ? { agentArguments } : {}),
    healAttempts: parseNonNegativeInteger(asString(parsed.values["heal-attempts"]), "--heal-attempts", 4),
    ...(verifyCommand ? { verifyCommand } : {}),
    ...(branch ? { branch } : {}),
    ...(targetBranch ? { targetBranch } : {}),
    help: parsed.values.help === true,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function resolvePromptPath(args: ParsedArgs, issueKey: string | undefined): string {
  if (args.promptPath) {
    return resolve(args.promptPath);
  }

  if (!issueKey) {
    throw new CliError("Missing --prompt or --issue value.");
  }

  return resolve(join(args.outDir, issueKey, "xray-test-implementation-prompt.md"));
}

async function assertFileExists(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new CliError(`Required implementation prompt was not found: ${path}`);
  }
}

async function collectChangedFiles(repoRoot: string, excludedPaths: string[]): Promise<string[]> {
  const excluded = new Set(excludedPaths.map((path) => relativeGitPath(repoRoot, path)).filter((path): path is string => path !== undefined));
  return parseGitChangedFiles(await gitStatusPorcelain(repoRoot)).filter((file) => !excluded.has(file));
}

function printHelp(): void {
  console.log(`Xray Test Healing

Usage:
  heal-xray-tests --issue ABC-123 --out ./out --verify-command "npm test"
  heal-xray-tests --prompt ./out/ABC-123/xray-test-implementation-prompt.md --verify-command "npm test"

Options:
  --issue <key>                  Jira issue key whose ./out/<key>/xray-test-implementation-prompt.md should be used.
  --out <dir>                    Output root directory. Defaults to ./out.
  --repo <dir>                   Repository root to edit. Defaults to the current working directory.
  --prompt <path>                Explicit implementation prompt path.
  --agent-command <command>      Optional explicit shell command for healing when --heal-agent-command is not supplied.
                                 When omitted, LLM_PROVIDER selects an SDK runner.
  --heal-agent-command <command> Optional shell command for verification repair attempts.
  --agent-path <path>            Executable override for the selected SDK provider.
  --agent-arguments <args>       Argument override for explicit shell commands only.
  --heal-attempts <number>       Maximum repair attempts after verification failure. Defaults to 4.
  --verify-command <command>     Shell validation command to run before and after healing.
  --branch <name>                Working branch name for prompt context. Defaults to current branch.
  --target-branch <name>         Target/base branch for prompt context. Defaults to origin HEAD or main.
  -h, --help                     Show this help.
`);
}

rejectInternalCliEntrypoint(import.meta.url, "implement-xray-tests --issue <key> --out <dir>");
