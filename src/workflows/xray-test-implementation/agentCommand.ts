import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { CliError } from "../../shared/cli.js";

export const DEFAULT_CODEX_EXEC_ARGUMENTS = "exec --ephemeral --ignore-rules --dangerously-bypass-approvals-and-sandbox -";
export const DEFAULT_CLAUDE_CODE_ARGUMENTS = "-p --input-format text --dangerously-skip-permissions";

export type ImplementationAgentProvider = "codex" | "claude";

export interface ResolveDefaultImplementationAgentCommandOptions {
  agentPath?: string;
  agentArguments?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ResolveDefaultCodexAgentCommandOptions {
  agentPath?: string;
  agentArguments?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveDefaultImplementationAgentCommand(options: ResolveDefaultImplementationAgentCommandOptions = {}): string {
  const env = options.env ?? process.env;
  const provider = resolveImplementationAgentProvider(options, env);

  if (provider === "claude") {
    return resolveDefaultClaudeCodeCommand({ ...options, env });
  }

  return resolveDefaultCodexAgentCommand({
    ...(options.agentPath ? { agentPath: options.agentPath } : {}),
    ...(options.agentArguments ? { agentArguments: options.agentArguments } : {}),
    env,
  });
}

export function resolveDefaultCodexAgentCommand(options: ResolveDefaultCodexAgentCommandOptions = {}): string {
  const env = options.env ?? process.env;
  const agentPath = firstNonEmpty(
    options.agentPath,
    env.MANSO_TEST_IMPLEMENTATION_AGENT_PATH,
  );
  const agentArguments = firstNonEmpty(
    options.agentArguments,
    env.MANSO_TEST_IMPLEMENTATION_AGENT_ARGUMENTS,
  )
    ?? DEFAULT_CODEX_EXEC_ARGUMENTS;
  const executable = agentPath
    ? quoteExecutable(agentPath)
    : `${quoteShellToken(process.execPath)} ${quoteShellToken(resolveBundledCodexCliPath())}`;

  return `${executable} ${agentArguments}`.trim();
}

export function resolveDefaultClaudeCodeCommand(options: ResolveDefaultImplementationAgentCommandOptions = {}): string {
  const env = options.env ?? process.env;
  const agentPath = firstNonEmpty(
    options.agentPath,
    env.MANSO_TEST_IMPLEMENTATION_AGENT_PATH,
  );
  const agentArguments = firstNonEmpty(
    options.agentArguments,
    env.MANSO_TEST_IMPLEMENTATION_AGENT_ARGUMENTS,
  )
    ?? DEFAULT_CLAUDE_CODE_ARGUMENTS;
  const executable = agentPath ? quoteExecutable(agentPath) : quoteShellToken(resolveBundledClaudeCodePath());

  return `${executable} ${agentArguments}`.trim();
}

export function implementationAgentProviderFromLlmProvider(value: string): ImplementationAgentProvider {
  const normalized = value.trim().toLowerCase();
  if (normalized === "openai") {
    return "codex";
  }
  if (normalized === "anthropic") {
    return "claude";
  }

  throw new CliError(`LLM_PROVIDER must be one of: openai, anthropic. Actual value: ${value}`);
}

export function resolveBundledCodexCliPath(): string {
  const require = createRequire(import.meta.url);
  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve("@openai/codex/package.json");
  } catch (error) {
    throw new CliError(
      `Could not resolve bundled @openai/codex. Install manso-testing-agent with dependencies or pass --agent-command. ${String(error)}`,
    );
  }

  const codexCliPath = join(dirname(packageJsonPath), "bin", "codex.js");
  if (!existsSync(codexCliPath)) {
    throw new CliError(`Bundled @openai/codex CLI was not found at ${codexCliPath}. Pass --agent-command to use a custom code agent.`);
  }

  return codexCliPath;
}

export function resolveBundledClaudeCodePath(): string {
  const require = createRequire(import.meta.url);
  let lastError: unknown;

  for (const packageName of claudeCodeNativePackageCandidates()) {
    let packageJsonPath: string;
    try {
      packageJsonPath = require.resolve(`${packageName}/package.json`);
    } catch (error) {
      lastError = error;
      continue;
    }

    const executablePath = join(dirname(packageJsonPath), process.platform === "win32" ? "claude.exe" : "claude");
    if (existsSync(executablePath)) {
      return executablePath;
    }

    lastError = new Error(`Expected Claude Code executable was not found at ${executablePath}.`);
  }

  throw new CliError(
    `Could not resolve bundled Claude Code from @anthropic-ai/claude-agent-sdk. Install dependencies with optional dependencies enabled or pass --agent-path. ${String(lastError)}`,
  );
}

function quoteShellToken(value: string): string {
  if (/^[A-Za-z0-9_/:=.,+@%-]+$/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '\\"')}"`;
}

function resolveImplementationAgentProvider(
  _options: ResolveDefaultImplementationAgentCommandOptions,
  env: NodeJS.ProcessEnv,
): ImplementationAgentProvider {
  const llmProvider = firstNonEmpty(env.LLM_PROVIDER);
  if (!llmProvider) {
    throw new CliError("Missing LLM_PROVIDER. Set LLM_PROVIDER=openai to use Codex or LLM_PROVIDER=anthropic to use Claude Code.");
  }

  return implementationAgentProviderFromLlmProvider(llmProvider);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => value !== undefined && value.trim().length > 0);
}

function quoteExecutable(value: string): string {
  const trimmed = value.trim();
  const executable = looksLikePath(trimmed) ? resolve(trimmed) : trimmed;
  return quoteShellToken(executable);
}

function looksLikePath(value: string): boolean {
  return value.startsWith(".")
    || value.includes("/")
    || value.includes("\\")
    || /^[A-Za-z]:/.test(value);
}

function claudeCodeNativePackageCandidates(): string[] {
  if (process.platform === "win32" && (process.arch === "x64" || process.arch === "arm64")) {
    return [`@anthropic-ai/claude-agent-sdk-win32-${process.arch}`];
  }
  if (process.platform === "darwin" && (process.arch === "x64" || process.arch === "arm64")) {
    return [`@anthropic-ai/claude-agent-sdk-darwin-${process.arch}`];
  }
  if (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) {
    return [
      `@anthropic-ai/claude-agent-sdk-linux-${process.arch}`,
      `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl`,
    ];
  }

  throw new CliError(`Bundled Claude Code is not available for ${process.platform}/${process.arch}. Pass --agent-path to use a custom executable.`);
}
