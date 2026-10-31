import type { CommandResult } from "../../domain/implementationPack/schema.js";
import { runShellCommand, type ShellRunOptions } from "../../integrations/shell/runShellCommand.js";

export interface VerifierInput {
  /** Verify command to run, e.g. "npx playwright test". */
  command: string;
  /** Absolute path to the target repo (working directory for the command). */
  repoRoot: string;
  /** Environment overrides merged on top of process.env. */
  env?: NodeJS.ProcessEnv;
  /** Optional millisecond timeout. */
  timeoutMs?: number;
}

/**
 * Verifier sub-agent (M9a): run the stack's verify command and capture the
 * structured result. Does not throw on non-zero exit — the orchestrator
 * decides what to do with a failed verification (heal loop in M9b).
 */
export async function runVerifier(input: VerifierInput): Promise<CommandResult> {
  const options: ShellRunOptions = {
    cwd: input.repoRoot,
    ...(input.env ? { env: input.env } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  };
  const result = await runShellCommand(input.command, options);
  return {
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    ...(result.stdout ? { stdout: result.stdout } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {}),
  };
}
