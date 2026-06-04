import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CliError } from "../../shared/cli.js";
import { asBoolean, asString, asStringArray, coerceStringOptionValues, parseNonNegativeInteger } from "../../shared/cliArgs.js";

export interface ParsedArgs {
  issue?: string;
  outDir: string;
  xrayTestGenerationPath?: string;
  repoRoot: string;
  guidancePaths: string[];
  promptPath?: string;
  agentCommand?: string;
  healAgentCommand?: string;
  agentPath?: string;
  agentArguments?: string;
  healAttempts: number;
  noHeal: boolean;
  verifyCommand?: string;
  branch?: string;
  targetBranch?: string;
  commitMessage?: string;
  prTitle?: string;
  prDescription?: string;
  configPath?: string;
  testDesignEnabled?: boolean;
  promptOnly: boolean;
  dryRun: boolean;
  allowDirty: boolean;
  reuseBranchIfPossible: boolean;
  help: boolean;
}

export interface ResolvedImplementationCommands {
  agentCommand: string;
  healAgentCommand: string;
}

export function parseXrayTestImplementationArgs(argv = process.argv.slice(2)): ParsedArgs {
  const parsed = parseArgs({
    args: coerceStringOptionValues(argv, ["agent-arguments"]),
    options: {
      issue: { type: "string" },
      out: { type: "string" },
      "xray-test-generation": { type: "string" },
      repo: { type: "string" },
      guidance: { type: "string", multiple: true },
      prompt: { type: "string" },
      "agent-command": { type: "string" },
      "heal-agent-command": { type: "string" },
      "agent-path": { type: "string" },
      "agent-arguments": { type: "string" },
      "heal-attempts": { type: "string" },
      "no-heal": { type: "boolean" },
      "verify-command": { type: "string" },
      branch: { type: "string" },
      "target-branch": { type: "string" },
      "commit-message": { type: "string" },
      "pr-title": { type: "string" },
      "pr-description": { type: "string" },
      config: { type: "string" },
      TestDesignEnabled: { type: "string" },
      "test-design-enabled": { type: "string" },
      "prompt-only": { type: "boolean" },
      "dry-run": { type: "boolean" },
      "allow-dirty": { type: "boolean" },
      "reuse-branch-if-possible": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  const values = parsed.values;
  const dryRun = asBoolean(values["dry-run"]);
  const issue = asString(values.issue);
  const xrayTestGenerationPath = asString(values["xray-test-generation"]);
  const promptPath = asString(values.prompt);
  const agentCommand = asString(values["agent-command"]);
  const healAgentCommand = asString(values["heal-agent-command"]);
  const agentPath = asString(values["agent-path"]);
  const agentArguments = asString(values["agent-arguments"]);
  const verifyCommand = asString(values["verify-command"]);
  const branch = asString(values.branch);
  const targetBranch = asString(values["target-branch"]);
  const commitMessage = asString(values["commit-message"]);
  const prTitle = asString(values["pr-title"]);
  const prDescription = asString(values["pr-description"]);
  const configPath = asString(values.config);
  const testDesignEnabled = parseOptionalBoolean(
    asString(values.TestDesignEnabled) ?? asString(values["test-design-enabled"]),
    "--TestDesignEnabled",
  );

  return {
    ...(issue ? { issue } : {}),
    outDir: asString(values.out) ?? "./out",
    ...(xrayTestGenerationPath ? { xrayTestGenerationPath } : {}),
    repoRoot: asString(values.repo) ?? process.cwd(),
    guidancePaths: asStringArray(values.guidance),
    ...(promptPath ? { promptPath } : {}),
    ...(agentCommand ? { agentCommand } : {}),
    ...(healAgentCommand ? { healAgentCommand } : {}),
    ...(agentPath ? { agentPath } : {}),
    ...(agentArguments ? { agentArguments } : {}),
    healAttempts: parseNonNegativeInteger(asString(values["heal-attempts"]), "--heal-attempts", 4),
    noHeal: asBoolean(values["no-heal"]),
    ...(verifyCommand ? { verifyCommand } : {}),
    ...(branch ? { branch } : {}),
    ...(targetBranch ? { targetBranch } : {}),
    ...(commitMessage ? { commitMessage } : {}),
    ...(prTitle ? { prTitle } : {}),
    ...(prDescription ? { prDescription } : {}),
    ...(configPath ? { configPath } : {}),
    ...(testDesignEnabled !== undefined ? { testDesignEnabled } : {}),
    promptOnly: asBoolean(values["prompt-only"]) || dryRun,
    dryRun,
    allowDirty: asBoolean(values["allow-dirty"]),
    reuseBranchIfPossible: asBoolean(values["reuse-branch-if-possible"]),
    help: asBoolean(values.help),
  };
}

function parseOptionalBoolean(value: string | undefined, optionName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new CliError(`${optionName} must be true or false. Actual value: ${value}`);
}

export function resolveXrayTestGenerationPath(args: ParsedArgs): string {
  if (args.xrayTestGenerationPath) {
    return resolve(args.xrayTestGenerationPath);
  }

  if (!args.issue) {
    throw new CliError("Missing --xray-test-generation or --issue value.");
  }

  return resolve(join(args.outDir, args.issue, "xray-test-generation.json"));
}

export function resolveImplementationOutputDir(args: ParsedArgs): string {
  return dirname(resolveXrayTestGenerationPath(args));
}

export function resolvePromptPath(args: ParsedArgs, outputDir: string): string {
  return resolve(args.promptPath ?? join(outputDir, "xray-test-implementation-prompt.md"));
}

export function resolveImplementationCommands(args: ParsedArgs): ResolvedImplementationCommands {
  const agentCommand = args.agentCommand
    ?? nonEmpty(process.env.MANSO_TEST_IMPLEMENTATION_COMMAND);

  if (!agentCommand) {
    throw new CliError("No shell implementation command is configured. Default implementation uses SDK runners; use resolveImplementationAgentRunners instead.");
  }

  return {
    agentCommand,
    healAgentCommand: args.healAgentCommand ?? agentCommand,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

export function promptOnlyReason(args: ParsedArgs): string {
  return args.dryRun
    ? "Dry run mode; implementation command, git mutation, push, and PR creation were skipped."
    : "Prompt-only mode; implementation command, git mutation, push, and PR creation were skipped.";
}

export function printXrayTestImplementationHelp(): void {
  console.log(`Xray Test Implementation

Usage:
  implement-xray-tests --issue ABC-123 --out ./out
  implement-xray-tests --issue ABC-123 --out ./out --TestDesignEnabled true
  implement-xray-tests --issue ABC-123 --out ./out --TestDesignEnabled false
  implement-xray-tests --issue ABC-123 --out ./out --agent-command "custom-agent -"
  implement-xray-tests --xray-test-generation ./out/ABC-123/xray-test-generation.json --prompt-only

Options:
  --issue <key>                    Jira issue key to design or load Xray tests for.
  --out <dir>                      Output root directory. Defaults to ./out.
  --xray-test-generation <path>    Explicit xray-test-generation.json path.
  --repo <dir>                     Repository root to edit. Defaults to the current working directory.
  --guidance <path>                Guidance file relative to repo root. May be repeated.
                                   Defaults to architecture/test-architecture.md,
                                   docs/testing/ai-test-generation.md,
                                   .manso/testgen.md, and .manso/repo-conventions.json.
  --prompt <path>                  Prompt output path. Defaults next to xray-test-generation.json.
  --agent-command <command>        Optional explicit shell command that implements tests. When omitted,
                                   LLM_PROVIDER selects an SDK runner: openai uses @openai/codex-sdk,
                                   anthropic uses @anthropic-ai/claude-agent-sdk.
  --heal-agent-command <command>   Optional shell command for verification repair attempts.
                                   Defaults to the selected implementation runner.
  --agent-path <path>              Executable override for the selected SDK provider.
                                   Env: MANSO_TEST_IMPLEMENTATION_AGENT_PATH.
  --agent-arguments <args>         Argument override for explicit shell commands only.
                                   Env: MANSO_TEST_IMPLEMENTATION_AGENT_ARGUMENTS.
  --heal-attempts <number>         Maximum repair attempts after verification failure. Defaults to 4.
  --no-heal                        Disable verification repair attempts.
  --verify-command <command>       Optional shell validation command to run before committing.
  --branch <name>                  Implementation branch. Defaults to tests/<issue>-xray-implementation.
  --target-branch <name>           PR target branch. Defaults to origin HEAD or main.
  --commit-message <message>       Commit message.
  --pr-title <title>               Pull request title.
  --pr-description <text>          Pull request description.
  --config <path>                  Optional JSON config for non-secret overrides.
  --TestDesignEnabled <true|false> When true, first runs generate-xray-tests for the issue and implements
                                   that generated design. When false, extracts existing linked Xray tests
                                   from the ticket and implements those. Alias: --test-design-enabled.
                                   Defaults to true when --issue is used without --xray-test-generation.
  --prompt-only                    Write the LLM prompt and output pack without editing git.
  --dry-run                        Alias for prompt-only with dry-run wording. When test design is enabled,
                                   the generated Xray design is local-only and is not uploaded.
  --allow-dirty                    Allow starting with a dirty worktree.
  --reuse-branch-if-possible       Reuse an active PR/source branch for this ticket when possible,
                                   including older suffixed implementation branches.
  -h, --help                       Show this help.
`);
}
