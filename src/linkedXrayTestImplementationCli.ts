#!/usr/bin/env node
import "dotenv/config";
import { parseArgs } from "node:util";
import { runContextExtractor } from "./contextExtractorCli.js";
import { CliError, rejectInternalCliEntrypoint } from "./shared/cli.js";
import { asBoolean, asString, asStringArray, parseNonNegativeInteger, readCommonContextArgs, type CommonContextArgs } from "./shared/cliArgs.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import { runXrayTestImplementation, type ParsedArgs as XrayTestImplementationArgs } from "./xrayTestImplementationCli.js";

async function main(): Promise<void> {
  const args = parseCliArgs();
  const logProgress = createProgressLogger("implement-linked-xray-tests");

  if (args.help) {
    printHelp();
    return;
  }

  if (!args.issue && !args.contextPath) {
    throw new CliError("Missing --issue or --context value.");
  }

  const contextResult = await runContextExtractor({
    ...(args.issue ? { issue: args.issue } : {}),
    outDir: args.outDir,
    ...(args.contextPath ? { contextPath: args.contextPath } : {}),
    ...(args.configPath ? { configPath: args.configPath } : {}),
    help: false,
  }, logProgress);
  if (!contextResult.xrayGenerationPath) {
    throw new CliError("No linked Xray tests were found to implement.");
  }

  logProgress("Invoking test implementation for existing linked Xray tests.");
  await runXrayTestImplementation(toImplementationArgs(args, contextResult.xrayGenerationPath, contextResult.issueKey));
}

interface ParsedArgs extends CommonContextArgs {
  repoRoot: string;
  guidancePaths: string[];
  promptPath?: string;
  agentCommand?: string;
  healAgentCommand?: string;
  healAttempts: number;
  noHeal: boolean;
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
  reuseBranchIfPossible: boolean;
  help: boolean;
}

function parseCliArgs(): ParsedArgs {
  const parsed = parseArgs({
    options: {
      issue: { type: "string" },
      out: { type: "string" },
      context: { type: "string" },
      repo: { type: "string" },
      guidance: { type: "string", multiple: true },
      prompt: { type: "string" },
      "agent-command": { type: "string" },
      "heal-agent-command": { type: "string" },
      "heal-attempts": { type: "string" },
      "no-heal": { type: "boolean" },
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
      "reuse-branch-if-possible": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  const common = readCommonContextArgs(parsed.values);
  const promptPath = asString(parsed.values.prompt);
  const agentCommand = asString(parsed.values["agent-command"]);
  const healAgentCommand = asString(parsed.values["heal-agent-command"]);
  const verifyCommand = asString(parsed.values["verify-command"]);
  const branch = asString(parsed.values.branch);
  const targetBranch = asString(parsed.values["target-branch"]);
  const commitMessage = asString(parsed.values["commit-message"]);
  const prTitle = asString(parsed.values["pr-title"]);
  const prDescription = asString(parsed.values["pr-description"]);
  return {
    ...common,
    repoRoot: asString(parsed.values.repo) ?? process.cwd(),
    guidancePaths: asStringArray(parsed.values.guidance),
    ...(promptPath ? { promptPath } : {}),
    ...(agentCommand ? { agentCommand } : {}),
    ...(healAgentCommand ? { healAgentCommand } : {}),
    healAttempts: parseNonNegativeInteger(asString(parsed.values["heal-attempts"]), "--heal-attempts", 4),
    noHeal: asBoolean(parsed.values["no-heal"]),
    ...(verifyCommand ? { verifyCommand } : {}),
    ...(branch ? { branch } : {}),
    ...(targetBranch ? { targetBranch } : {}),
    ...(commitMessage ? { commitMessage } : {}),
    ...(prTitle ? { prTitle } : {}),
    ...(prDescription ? { prDescription } : {}),
    promptOnly: asBoolean(parsed.values["prompt-only"]) || asBoolean(parsed.values["dry-run"]),
    dryRun: asBoolean(parsed.values["dry-run"]),
    allowDirty: asBoolean(parsed.values["allow-dirty"]),
    reuseBranchIfPossible: asBoolean(parsed.values["reuse-branch-if-possible"]),
    help: common.help,
  };
}

function toImplementationArgs(args: ParsedArgs, xrayTestGenerationPath: string, issueKey: string): XrayTestImplementationArgs {
  return {
    issue: issueKey,
    outDir: args.outDir,
    xrayTestGenerationPath,
    repoRoot: args.repoRoot,
    guidancePaths: args.guidancePaths,
    ...(args.promptPath ? { promptPath: args.promptPath } : {}),
    ...(args.agentCommand ? { agentCommand: args.agentCommand } : {}),
    ...(args.healAgentCommand ? { healAgentCommand: args.healAgentCommand } : {}),
    healAttempts: args.healAttempts,
    noHeal: args.noHeal,
    ...(args.verifyCommand ? { verifyCommand: args.verifyCommand } : {}),
    ...(args.branch ? { branch: args.branch } : {}),
    ...(args.targetBranch ? { targetBranch: args.targetBranch } : {}),
    ...(args.commitMessage ? { commitMessage: args.commitMessage } : {}),
    ...(args.prTitle ? { prTitle: args.prTitle } : {}),
    ...(args.prDescription ? { prDescription: args.prDescription } : {}),
    ...(args.configPath ? { configPath: args.configPath } : {}),
    promptOnly: args.promptOnly,
    dryRun: args.dryRun,
    allowDirty: args.allowDirty,
    reuseBranchIfPossible: args.reuseBranchIfPossible,
    help: false,
  };
}

function printHelp(): void {
  console.log(`Linked Xray Test Implementation

Usage:
  implement-linked-xray-tests --issue ABC-123 --out ./out --prompt-only
  implement-linked-xray-tests --context ./out/ABC-123/context.json --prompt-only

Options:
  --issue <key>                    Jira issue key to extract and implement linked Xray tests for.
  --context <path>                 Existing context.json to use instead of extracting Jira again.
  --out <dir>                      Output root directory. Defaults to ./out.
  --repo <dir>                     Repository root to edit. Defaults to the current working directory.
  --guidance <path>                Guidance file relative to repo root. May be repeated.
  --prompt <path>                  Prompt output path. Defaults next to xray-test-generation.json.
  --agent-command <command>        Optional explicit shell command that implements tests.
  --heal-agent-command <command>   Optional shell command for verification repair attempts.
                                   Defaults to the selected implementation runner.
  --heal-attempts <number>         Maximum repair attempts after verification failure. Defaults to 4.
  --no-heal                        Disable verification repair attempts.
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
  --reuse-branch-if-possible       If origin already has the implementation branch, check it out and
                                   fast-forward it instead of creating a fresh branch from the target branch.
  -h, --help                       Show this help.
`);
}

rejectInternalCliEntrypoint(import.meta.url, "implement-xray-tests --issue <key> --out <dir> --TestDesignEnabled false");
