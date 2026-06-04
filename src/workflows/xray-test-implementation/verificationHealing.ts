import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolProvenance } from "../../domain/contextPack/schema.js";
import type {
  XrayTestImplementationCommandResult,
  XrayTestImplementationHealingAttempt,
} from "../../domain/xrayTestImplementation/schema.js";
import { mirrorFileToMemory } from "../../memory/memoryCabin.js";
import { runShellCommand, type ShellRunResult } from "../../integrations/git/localGit.js";
import { CliError } from "../../shared/cli.js";
import { buildXrayTestHealingPrompt } from "./prompt.js";
import { buildCommandEnvironment } from "./implementationGit.js";
import {
  runImplementationAgent,
  type ImplementationAgentRunner,
} from "./agentRunner.js";
import type { ObservabilityTelemetryConfig } from "../../integrations/llm/types.js";

export async function runCheckedShellCommand(
  command: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<XrayTestImplementationCommandResult> {
  const result = await runShellCommandResult(command, repoRoot, env, stdin, true);
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed with exit code ${result.exitCode}.`);
  }

  return withoutOutput(result);
}

export async function runShellCommandResult(
  command: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  stdin: string | undefined,
  includeOutput = true,
): Promise<XrayTestImplementationCommandResult> {
  const result = await runShellCommand(command, repoRoot, env, stdin);
  return toCommandResult(result, includeOutput);
}

export interface RunVerificationHealingLoopOptions {
  issueKey: string;
  repoRoot: string;
  branch: string;
  targetBranch: string;
  promptPath: string;
  outputDir?: string;
  verifyCommand: string;
  healAgentRunner: ImplementationAgentRunner;
  telemetry?: ObservabilityTelemetryConfig;
  maxHealAttempts: number;
  initialVerification?: XrayTestImplementationCommandResult;
  healingPromptPaths?: string[];
  getChangedFiles: (healingPromptPaths: string[]) => Promise<string[]>;
  logProgress: (message: string) => void;
  tools?: ToolProvenance[];
}

export interface VerificationHealingLoopResult {
  verification: XrayTestImplementationCommandResult;
  healingAttempts: XrayTestImplementationHealingAttempt[];
  healingPromptPaths: string[];
  changedFiles: string[];
  passed: boolean;
  failureMessage?: string;
}

export async function runVerificationHealingLoop(options: RunVerificationHealingLoopOptions): Promise<VerificationHealingLoopResult> {
  const tools = options.tools ?? [];
  const outputDir = options.outputDir ?? dirname(options.promptPath);
  const healingPromptPaths = [...(options.healingPromptPaths ?? [])];
  const healingAttempts: XrayTestImplementationHealingAttempt[] = [];
  let changedFiles = await options.getChangedFiles(healingPromptPaths);
  let verification = options.initialVerification
    ?? await runShellCommandResult(
      options.verifyCommand,
      options.repoRoot,
      buildCommandEnvironment(options.promptPath, options.issueKey, options.branch, options.targetBranch),
      undefined,
      true,
    );

  if (!options.initialVerification) {
    tools.push({
      method: "runVerificationCommand",
      toolName: "shell:verify-command",
      calledAt: new Date().toISOString(),
      success: verification.exitCode === 0,
      ...(verification.exitCode === 0 ? {} : { message: `Verification failed with exit code ${verification.exitCode}.` }),
    });
  }

  if (verification.exitCode === 0) {
    return { verification, healingAttempts, healingPromptPaths, changedFiles, passed: true };
  }

  for (let attempt = 1; attempt <= options.maxHealAttempts; attempt += 1) {
    changedFiles = await options.getChangedFiles(healingPromptPaths);
    const healingPromptPath = join(outputDir, `xray-test-healing-attempt-${attempt}.md`);
    healingPromptPaths.push(healingPromptPath);
    const healingPrompt = buildXrayTestHealingPrompt({
      issueKey: options.issueKey,
      repoRoot: options.repoRoot,
      branch: options.branch,
      targetBranch: options.targetBranch,
      originalPromptPath: options.promptPath,
      attempt,
      maxAttempts: options.maxHealAttempts,
      verification,
      changedFiles,
    });
    await writeHealingPrompt(healingPromptPath, healingPrompt, options.issueKey, options.logProgress, tools);

    options.logProgress(`Running healing agent, attempt ${attempt} of ${options.maxHealAttempts}.`);
    const healCommand = await runImplementationAgent(
      options.healAgentRunner,
      {
        issueKey: options.issueKey,
        repoRoot: options.repoRoot,
        prompt: healingPrompt,
        env: buildCommandEnvironment(options.promptPath, options.issueKey, options.branch, options.targetBranch, healingPromptPath),
        phase: "healing",
      },
      options.telemetry,
    );
    tools.push({
      method: "runHealingCommand",
      toolName: `agent:${options.healAgentRunner.kind}`,
      calledAt: new Date().toISOString(),
      success: healCommand.exitCode === 0,
      ...(healCommand.exitCode === 0 ? {} : { message: `Healing command failed with exit code ${healCommand.exitCode}.` }),
    });

    changedFiles = await options.getChangedFiles(healingPromptPaths);
    if (healCommand.exitCode !== 0) {
      healingAttempts.push({
        attempt,
        promptPath: healingPromptPath,
        command: healCommand,
        verification,
        changedFiles,
      });
      return {
        verification,
        healingAttempts,
        healingPromptPaths,
        changedFiles,
        passed: false,
        failureMessage: `Healing command failed on attempt ${attempt}.`,
      };
    }

    verification = await runShellCommandResult(
      options.verifyCommand,
      options.repoRoot,
      buildCommandEnvironment(options.promptPath, options.issueKey, options.branch, options.targetBranch),
      undefined,
      true,
    );
    tools.push({
      method: "runHealingVerificationCommand",
      toolName: "shell:verify-command",
      calledAt: new Date().toISOString(),
      success: verification.exitCode === 0,
      ...(verification.exitCode === 0 ? {} : { message: `Verification failed after healing attempt ${attempt} with exit code ${verification.exitCode}.` }),
    });
    healingAttempts.push({
      attempt,
      promptPath: healingPromptPath,
      command: healCommand,
      verification,
      changedFiles,
    });

    if (verification.exitCode === 0) {
      return { verification, healingAttempts, healingPromptPaths, changedFiles, passed: true };
    }
  }

  return {
    verification,
    healingAttempts,
    healingPromptPaths,
    changedFiles,
    passed: false,
    failureMessage: `Verification failed after ${healingAttempts.length} healing attempt(s).`,
  };
}

export function assertHealingPassed(result: VerificationHealingLoopResult): void {
  if (!result.passed) {
    throw new CliError(result.failureMessage ?? "Verification healing failed.");
  }
}

async function writeHealingPrompt(
  promptPath: string,
  prompt: string,
  issueKey: string,
  logProgress: (message: string) => void,
  tools: ToolProvenance[],
): Promise<void> {
  await mkdir(dirname(promptPath), { recursive: true });
  await writeFile(promptPath, prompt, "utf8");
  await mirrorFileToMemory({
    workflow: "xray-test-healing-prompt",
    path: promptPath,
    kind: "markdown",
    scope: { type: "jira", id: issueKey },
  });
  logProgress(`Wrote healing prompt to ${promptPath}.`);
  tools.push({
    method: "writeHealingPrompt",
    toolName: "file:write",
    calledAt: new Date().toISOString(),
    success: true,
  });
}

function toCommandResult(result: ShellRunResult, includeOutput: boolean): XrayTestImplementationCommandResult {
  return {
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    ...(includeOutput && result.stdout ? { stdout: result.stdout } : {}),
    ...(includeOutput && result.stderr ? { stderr: result.stderr } : {}),
  };
}

function withoutOutput(result: XrayTestImplementationCommandResult): XrayTestImplementationCommandResult {
  return {
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
}
