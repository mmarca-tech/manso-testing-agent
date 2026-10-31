import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Error type whose message is shown to the user without a stack trace. */
export class CliError extends Error {}

/**
 * Parse a CLI flag whose value is a JSON object string (e.g.
 * `--test-fields '{"customfield_15714":170}'`). Returns `undefined` for an
 * absent/empty value, and throws {@link CliError} when the value is not valid
 * JSON or not a plain object (arrays/scalars rejected).
 */
export function parseJsonObjectArg(
  value: string | undefined,
  flagName: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new CliError(`${flagName} must be a JSON object string. ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`${flagName} must be a JSON object (got ${Array.isArray(parsed) ? "array" : typeof parsed}).`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Merge the extra Jira fields for created Test issues from their three
 * sources, least- to most-specific: the repo's `.agents` `xray.testFields`,
 * a `--reporter <accountId>` flag (sugar for per-QA attribution — e.g. a Jira
 * automation rule passing `{{initiator.accountId}}`), and a raw
 * `--test-fields '{...}'` blob (the power tool; an explicit `reporter` key in
 * it wins over the flag).
 */
export function mergeTestFields(
  configFields: Record<string, unknown> | undefined,
  reporterAccountId: string | undefined,
  flagFields: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const reporter = reporterAccountId?.trim();
  return {
    ...(configFields ?? {}),
    ...(reporter ? { reporter: { id: reporter } } : {}),
    ...(flagFields ?? {}),
  };
}

/**
 * Parse a CLI flag whose value is a boolean (`true`/`false`, also `1`/`0`,
 * `yes`/`no`, `on`/`off`). Returns `undefined` for an absent/empty value (so a
 * pipeline can always pass the flag and an empty value means "unset → fall back
 * to config/default"), and throws {@link CliError} on an unrecognized value.
 */
export function parseBoolArg(value: string | undefined, flagName: string): boolean | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const v = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  throw new CliError(`${flagName} must be true or false (got "${value}").`);
}

/**
 * True when the module identified by `metaUrl` is the process entrypoint,
 * i.e. it was run directly rather than imported. Used to guard CLI auto-run
 * blocks so the same module stays safely importable from tests and libraries.
 */
export function isCliEntrypoint(metaUrl: string): boolean {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return resolve(process.argv[1]) === resolve(fileURLToPath(metaUrl));
  }
}

/** Print an error sensibly and set a failing exit code. */
export function handleCliError(error: unknown): void {
  if (error instanceof CliError) {
    console.error(error.message);
  } else if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }

  process.exitCode = 1;
}
