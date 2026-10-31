import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";

/**
 * Load `.env` into `process.env`, but only for keys that are currently **unset
 * or empty**.
 *
 * Standard `dotenv` refuses to overwrite any variable already present in the
 * environment — including empty placeholders (`ANTHROPIC_API_KEY=""`) injected
 * by a shell or a parent process. That silently shadows real values placed in
 * `.env`. This loader keeps the 12-factor rule (a real, non-empty environment
 * value still wins) while letting `.env` fill in the blanks.
 *
 * @returns the names of variables that were applied from the file.
 */
export function loadEnv(cwd: string = process.cwd()): string[] {
  const path = resolve(cwd, ".env");
  if (!existsSync(path)) {
    return [];
  }

  const parsed = parse(readFileSync(path));
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    const current = process.env[key];
    if (current === undefined || current.trim() === "") {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}
