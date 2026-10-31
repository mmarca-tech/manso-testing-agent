import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read Manso's version from package.json. Works both when running compiled
 * (`dist/cli/version.js`) and via tsx (`src/cli/version.ts`) — in both layouts
 * package.json sits two directories above this file.
 */
export function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(here, "..", "..", "package.json");
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : "0.0.0";
}
