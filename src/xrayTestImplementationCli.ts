#!/usr/bin/env node
import "dotenv/config";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import type { ToolProvenance, Warning } from "./domain/contextPack/schema.js";
import type {
  XrayTestImplementationCommandResult,
  XrayTestImplementationHealingAttempt,
  XrayTestImplementationPullRequest,
} from "./domain/xrayTestImplementation/schema.js";
import { XrayTestGenerationPackSchema } from "./domain/xrayTestGeneration/schema.js";
import { AzureDevOpsClient } from "./integrations/azureDevOps/client.js";
import {
  AzureDevOpsPullRequestCreator,
  resolveAzureDevOpsRepository,
} from "./integrations/azureDevOps/pullRequestCreator.js";
import {
  createTracedWorkflow,
  flushTelemetry,
  jiraIssueSessionId,
  setActiveSpanAttributes,
} from "./integrations/llm/telemetry/observability.js";
import {
  gitCurrentHeadSha,
  gitCurrentRemoteUrl,
  runGit,
} from "./integrations/git/localGit.js";
import { mirrorFileToMemory } from "./memory/memoryCabin.js";
import { runContextExtractor } from "./contextExtractorCli.js";
import { writeXrayTestImplementationPack } from "./output/xray-test-implementation/writer.js";
import { CliError, handleCliError, isCliEntrypoint } from "./shared/cli.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import { runGenerateXrayTests } from "./xrayTestGenerationCli.js";
import {
  buildXrayTestImplementationPrompt,
  DEFAULT_REPO_GUIDANCE_PATHS,
  type XrayTestImplementationGuidanceContent,
} from "./workflows/xray-test-implementation/prompt.js";
import {
  parseXrayTestImplementationArgs,
  printXrayTestImplementationHelp,
  promptOnlyReason,
  resolvePromptPath,
  resolveXrayTestGenerationPath,
  type ParsedArgs,
} from "./workflows/xray-test-implementation/implementationArgs.js";
import {
  resolveImplementationAgentRunners,
  runImplementationAgent,
} from "./workflows/xray-test-implementation/agentRunner.js";
import {
  assertCleanWorktree,
  buildCommandEnvironment,
  checkoutImplementationBranch,
  collectImplementationChangedFiles,
  defaultImplementationBranch,
  normalizeBranchName,
  resolveTargetBranch,
} from "./workflows/xray-test-implementation/implementationGit.js";
import {
  buildXrayTestImplementationPack,
  writeFailedImplementationPack,
} from "./workflows/xray-test-implementation/implementationPackWriter.js";
import {
  runShellCommandResult,
  runVerificationHealingLoop,
} from "./workflows/xray-test-implementation/verificationHealing.js";

export type { ParsedArgs } from "./workflows/xray-test-implementation/implementationArgs.js";

async function main(): Promise<void> {
  const args = parseXrayTestImplementationArgs();

  if (args.help) {
    printXrayTestImplementationHelp();
    return;
  }

  try {
    await runXrayTestImplementation(args);
  } finally {
    await flushTelemetry();
  }
}

export async function runXrayTestImplementation(
  args: ParsedArgs,
  logProgress = createProgressLogger("implement-xray-tests"),
): Promise<void> {
  const config = await loadRuntimeConfig({
    ...(args.configPath ? { configPath: args.configPath } : {}),
  });
  const tracedWorkflow = createTracedWorkflow(
    (input: ParsedArgs) => runXrayTestImplementationUntraced(input, logProgress, config),
    config.observability?.telemetry,
    {
      name: "workflow.implement-xray-tests",
      attributes: {
        "workflow.name": "implement-xray-tests",
        ...(args.issue ? { "workflow.issue": args.issue } : {}),
        "workflow.prompt_only": args.promptOnly,
        "workflow.dry_run": args.dryRun,
      },
      sessionId: (input) => jiraIssueSessionId(input.issue),
      input: (input) => ({
        issue: input.issue,
        xrayTestGenerationPath: input.xrayTestGenerationPath,
        outDir: input.outDir,
        repoRoot: input.repoRoot,
        testDesignEnabled: input.testDesignEnabled,
        promptOnly: input.promptOnly,
        dryRun: input.dryRun,
      }),
      output: () => ({ status: "completed" }),
    },
  );

  await tracedWorkflow(args);
}

async function runXrayTestImplementationUntraced(
  args: ParsedArgs,
  logProgress: (message: string) => void,
  config: Awaited<ReturnType<typeof loadRuntimeConfig>>,
): Promise<void> {
  const xrayTestGenerationPath = await resolveImplementationGenerationPack(args, config, logProgress);
  await runTracedImplementationFromPack(
    {
      ...args,
      xrayTestGenerationPath,
    },
    config,
    logProgress,
  );
}

export async function runXrayTestImplementationFromPack(
  args: ParsedArgs,
  logProgress = createProgressLogger("implement-xray-tests"),
): Promise<void> {
  const config = await loadRuntimeConfig({
    ...(args.configPath ? { configPath: args.configPath } : {}),
  });
  const repoRoot = resolve(args.repoRoot);
  const xrayTestGenerationPath = resolveXrayTestGenerationPath(args);
  const outputDir = dirname(xrayTestGenerationPath);
  logProgress(`Loading Xray test generation pack from ${xrayTestGenerationPath}.`);
  const generation = XrayTestGenerationPackSchema.parse(JSON.parse(await readFile(xrayTestGenerationPath, "utf8")));
  setActiveSpanAttributes({ "workflow.issue": generation.ticket.key });

  let branch = normalizeBranchName(args.branch ?? defaultImplementationBranch(generation.ticket.key));
  const targetBranch = await resolveTargetBranch(repoRoot, args.targetBranch);
  if (branch === targetBranch) {
    throw new CliError(`Implementation branch must differ from the PR target/base branch (${targetBranch}).`);
  }
  const warnings: Warning[] = [];
  const tools: ToolProvenance[] = [];

  if (args.reuseBranchIfPossible && !args.promptOnly) {
    branch = await resolveReusableImplementationBranch({
      args,
      repoRoot,
      issueKey: generation.ticket.key,
      branch,
      targetBranch,
      tools,
      logProgress,
    });
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

  if (args.promptOnly) {
    await writePrompt(promptPath, prompt, generation.ticket.key, logProgress, tools);
    const pack = buildXrayTestImplementationPack({
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
        warnings: [promptOnlyReason(args)],
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

  const agents = resolveImplementationAgentRunners(args, config);
  const startingChangedFiles = await assertCleanWorktree(repoRoot, args.allowDirty);
  const checkout = await checkoutImplementationBranch({
    repoRoot,
    branch,
    targetBranch,
    reuseBranchIfPossible: args.reuseBranchIfPossible,
    tools,
    logProgress,
  });
  await writePrompt(promptPath, prompt, generation.ticket.key, logProgress, tools);

  logProgress(`Running test implementation agent through ${agents.implementation.commandLabel}.`);
  const implementationCommand = await runImplementationAgent(
    agents.implementation,
    {
      issueKey: generation.ticket.key,
      repoRoot,
      prompt,
      env: buildCommandEnvironment(promptPath, generation.ticket.key, branch, targetBranch),
      phase: "implementation",
    },
    config.observability?.telemetry,
  );
  if (implementationCommand.exitCode !== 0) {
    throw new Error(`${implementationCommand.command} failed with exit code ${implementationCommand.exitCode}.`);
  }
  tools.push({
    method: "runImplementationCommand",
    toolName: `agent:${agents.implementation.kind}`,
    calledAt: new Date().toISOString(),
    success: true,
  });

  let healingPromptPaths: string[] = [];
  let changedFiles = await collectImplementationChangedFiles({
    repoRoot,
    startingChangedFiles,
    promptPath,
    extraExcludedPaths: healingPromptPaths,
  });
  if (changedFiles.length === 0) {
    if (!checkout.reusedExistingBranch) {
      throw new CliError("Implementation command completed but did not leave any repository changes to commit.");
    }

    logProgress("Implementation command completed without repository changes; continuing with the reused implementation branch.");
    warnings.push({
      section: "implementation",
      toolName: `agent:${agents.implementation.kind}`,
      message: "Implementation command completed without repository changes; reused the existing implementation branch.",
    });
  } else {
    logProgress(`Implementation changed ${changedFiles.length} file(s).`);
  }

  const verifyCommand = args.verifyCommand ?? nonEmpty(process.env.MANSO_TEST_VERIFY_COMMAND);
  let verification = verifyCommand
    ? await runShellCommandResult(verifyCommand, repoRoot, buildCommandEnvironment(promptPath, generation.ticket.key, branch, targetBranch), undefined, true)
    : undefined;
  let healingAttempts: XrayTestImplementationHealingAttempt[] = [];
  if (verification) {
    tools.push({
      method: "runVerificationCommand",
      toolName: "shell:verify-command",
      calledAt: new Date().toISOString(),
      success: verification.exitCode === 0,
      ...(verification.exitCode === 0 ? {} : { message: `Verification failed with exit code ${verification.exitCode}.` }),
    });
  } else {
    warnings.push({
      section: "verification",
      toolName: "shell",
      message: "No verification command was provided. Set --verify-command or MANSO_TEST_VERIFY_COMMAND to run repository validation.",
    });
  }

  if (verifyCommand && verification && verification.exitCode !== 0) {
    const maxHealAttempts = args.noHeal ? 0 : args.healAttempts;
    const healingResult = await runVerificationHealingLoop({
      issueKey: generation.ticket.key,
      repoRoot,
      branch,
      targetBranch,
      promptPath,
      outputDir,
      verifyCommand,
      healAgentRunner: agents.healing,
      ...(config.observability?.telemetry ? { telemetry: config.observability.telemetry } : {}),
      maxHealAttempts,
      initialVerification: verification,
      healingPromptPaths,
      getChangedFiles: (paths) => collectImplementationChangedFiles({
        repoRoot,
        startingChangedFiles,
        promptPath,
        extraExcludedPaths: paths,
      }),
      logProgress,
      tools,
    });
    verification = healingResult.verification;
    healingAttempts = healingResult.healingAttempts;
    healingPromptPaths = healingResult.healingPromptPaths;
    changedFiles = healingResult.changedFiles;

    if (!healingResult.passed) {
      const message = healingResult.failureMessage ?? `Verification failed after ${healingAttempts.length} healing attempt(s).`;
      await writeFailedImplementationPack({
        generation,
        xrayTestGenerationPath,
        repoRoot,
        branch,
        targetBranch,
        promptPath,
        guidanceFiles,
        implementationCommand,
        verification,
        healingAttempts,
        changedFiles,
        tools,
        warnings,
        outputDir,
        message,
      });
      throw new CliError(`${message} See xray-test-implementation.json/xray-test-implementation.md.`);
    }
  }

  changedFiles = await collectImplementationChangedFiles({
    repoRoot,
    startingChangedFiles,
    promptPath,
    extraExcludedPaths: healingPromptPaths,
  });
  if (changedFiles.length === 0) {
    if (!checkout.reusedExistingBranch) {
      throw new CliError("No implementation changes remained after verification.");
    }

    logProgress("No implementation changes remained after verification; skipping commit and push for the reused branch.");
  }

  let pushed = false;
  if (changedFiles.length > 0) {
    logProgress("Committing implementation changes.");
    await runGit(repoRoot, ["add", "-A", "--", ...changedFiles]);
    const commitMessage = args.commitMessage ?? `${generation.ticket.key}: implement generated Xray tests`;
    await runGit(repoRoot, ["commit", "-m", commitMessage]);
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
    pushed = true;
  }
  const commitSha = await gitCurrentHeadSha(repoRoot);

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

  const pack = buildXrayTestImplementationPack({
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
    ...(healingAttempts.length > 0 ? { healingAttempts } : {}),
    changedFiles,
    commitSha,
    pushed,
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

async function resolveImplementationGenerationPack(
  args: ParsedArgs,
  config: Awaited<ReturnType<typeof loadRuntimeConfig>>,
  logProgress: (message: string) => void,
): Promise<string> {
  if (args.xrayTestGenerationPath) {
    logProgress(`Using explicit Xray test generation pack ${args.xrayTestGenerationPath}.`);
    return args.xrayTestGenerationPath;
  }

  if (!args.issue) {
    throw new CliError("Missing --issue or --xray-test-generation value.");
  }

  const testDesignEnabled = args.testDesignEnabled ?? true;
  if (testDesignEnabled) {
    logProgress("Test design is enabled; running generate-xray-tests before implementation.");
    const result = await runGenerateXrayTests(
      {
        issue: args.issue,
        outDir: args.outDir,
        ...(args.configPath ? { configPath: args.configPath } : {}),
        dryRun: args.dryRun,
        help: false,
      },
      logProgress,
    );
    return result.jsonPath;
  }

  logProgress("Test design is disabled; extracting existing linked Xray tests from the ticket.");
  const tracedContextExtractor = createTracedWorkflow(
    (input: ParsedArgs) => runContextExtractor({
      ...(input.issue ? { issue: input.issue } : {}),
      outDir: input.outDir,
      ...(input.configPath ? { configPath: input.configPath } : {}),
      help: false,
    }, logProgress),
    config.observability?.telemetry,
    {
      name: "task.context-extractor",
      attributes: {
        "workflow.name": "context-extractor",
        "workflow.issue": args.issue,
      },
      sessionId: (input) => jiraIssueSessionId(input.issue),
      input: (input) => ({
        issue: input.issue,
        outDir: input.outDir,
        configPath: input.configPath,
      }),
      output: (output) => output,
    },
  );
  const contextResult = await tracedContextExtractor(args);
  if (!contextResult.xrayGenerationPath) {
    throw new CliError(`No linked Xray tests were found on ${args.issue}; cannot implement existing test cases with --TestDesignEnabled false.`);
  }

  return contextResult.xrayGenerationPath;
}

async function runTracedImplementationFromPack(
  args: ParsedArgs,
  config: Awaited<ReturnType<typeof loadRuntimeConfig>>,
  logProgress: (message: string) => void,
): Promise<void> {
  const tracedImplementation = createTracedWorkflow(
    (input: ParsedArgs) => runXrayTestImplementationFromPack(input, logProgress),
    config.observability?.telemetry,
    {
      name: "workflow.test-implementation",
      attributes: {
        "workflow.name": "test-implementation",
        ...(args.issue ? { "workflow.issue": args.issue } : {}),
        "workflow.prompt_only": args.promptOnly,
        "workflow.dry_run": args.dryRun,
      },
      sessionId: (input) => jiraIssueSessionId(input.issue),
      input: (input) => ({
        issue: input.issue,
        xrayTestGenerationPath: input.xrayTestGenerationPath,
        repoRoot: input.repoRoot,
        branch: input.branch,
        targetBranch: input.targetBranch,
        promptOnly: input.promptOnly,
        dryRun: input.dryRun,
      }),
      output: () => ({ status: "completed" }),
    },
  );

  await tracedImplementation(args);
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
  issueKey: string,
  logProgress: (message: string) => void,
  tools: ToolProvenance[],
): Promise<void> {
  await mkdir(dirname(promptPath), { recursive: true });
  await writeFile(promptPath, prompt, "utf8");
  await mirrorFileToMemory({
    workflow: "xray-test-implementation-prompt",
    path: promptPath,
    kind: "markdown",
    scope: { type: "jira", id: issueKey },
  });
  logProgress(`Wrote implementation prompt to ${promptPath}.`);
  tools.push({
    method: "writeImplementationPrompt",
    toolName: "file:write",
    calledAt: new Date().toISOString(),
    success: true,
  });
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
  if (options.args.reuseBranchIfPossible) {
    options.logProgress("Looking for an existing active Azure DevOps pull request for the implementation branch.");
    const existing = await creator.findActive({
      repository,
      sourceBranch: options.branch,
      targetBranch: options.targetBranch,
    });
    if (existing) {
      options.tools.push({
        method: "findActivePullRequest",
        toolName: "azure-devops:pullrequests",
        calledAt: new Date().toISOString(),
        success: true,
      });

      return {
        status: "reused",
        provider: "azure-devops",
        id: existing.id,
        url: existing.url,
        title: options.title,
        sourceBranch: options.branch,
        targetBranch: options.targetBranch,
        warnings: [],
      };
    }
  }

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

async function resolveReusableImplementationBranch(options: {
  args: ParsedArgs;
  repoRoot: string;
  issueKey: string;
  branch: string;
  targetBranch: string;
  tools: ToolProvenance[];
  logProgress: (message: string) => void;
}): Promise<string> {
  const config = await loadRuntimeConfig({
    ...(options.args.configPath ? { configPath: options.args.configPath } : {}),
  });
  if (!config.azureDevOps) {
    options.logProgress("Cannot look for an existing implementation PR because Azure DevOps authentication is not configured.");
    return options.branch;
  }

  const remoteUrl = await gitCurrentRemoteUrl(options.repoRoot);
  const repository = resolveAzureDevOpsRepository(remoteUrl);
  if (!repository) {
    options.logProgress(`Cannot look for an existing implementation PR because the Azure DevOps repository could not be resolved from origin remote ${remoteUrl}.`);
    return options.branch;
  }

  const creator = new AzureDevOpsPullRequestCreator(new AzureDevOpsClient({ token: config.azureDevOps.token }));
  options.logProgress("Looking for an existing active Azure DevOps pull request to reuse before choosing the implementation branch.");
  const existing = await creator.findActiveForBranchReuse({
    repository,
    sourceBranch: options.branch,
    targetBranch: options.targetBranch,
    issueKey: options.issueKey,
  });
  if (!existing?.sourceBranch) {
    return options.branch;
  }

  const reusableBranch = normalizeBranchName(existing.sourceBranch);
  if (reusableBranch !== options.branch) {
    options.logProgress(`Reusing implementation branch ${reusableBranch} from active Azure DevOps PR ${existing.id}.`);
  }

  options.tools.push({
    method: "findReusableImplementationBranch",
    toolName: "azure-devops:pullrequests",
    calledAt: new Date().toISOString(),
    success: true,
  });
  return reusableBranch;
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

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

if (isCliEntrypoint(import.meta.url)) {
  main().catch(handleCliError);
}
