import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class CliError extends Error {}

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

export function rejectInternalCliEntrypoint(metaUrl: string, replacement: string): void {
  if (!isCliEntrypoint(metaUrl)) {
    return;
  }

  console.error(`This internal workflow module is not a public CLI entrypoint. Use ${replacement}.`);
  process.exitCode = 1;
}
