import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CliError } from "../shared/cli.js";

/** Optional external history; independent of `.agents/memory/`. */
export const MemoryCabinConfigSchema = z.object({
  enabled: z.boolean().default(false),
  root: z.string().min(1).optional(),
  branch: z.string().min(1).default("main"),
  cacheDir: z.string().min(1).default(join(homedir(), ".manso", "memory-cabins")),
  strict: z.boolean().default(false),
  readContext: z.boolean().default(true),
  maxContextChars: z.number().int().min(0).max(16000).default(8000),
}).strict();

export type MemoryCabinConfig = z.infer<typeof MemoryCabinConfigSchema>;

const TRUE_VALUES = ["1", "true", "yes", "on"];
const FALSE_VALUES = ["0", "false", "no", "off"];
const warned = new Set<string>();

/**
 * Resolve explicit runtime configuration and MANSO_MEMORY_* overrides.
 *
 * Memory is optional, so a misconfiguration must never block the core
 * workflows: unless the cabin was explicitly enabled, problems are warned about
 * and the cabin stays off. An explicitly enabled cabin still fails loudly.
 */
export function loadMemoryCabinConfig(configured: unknown = {}): MemoryCabinConfig {
  const problems: string[] = [];
  const disabled = MemoryCabinConfigSchema.parse({});
  // Blank values and an unmapped pipeline variable ("$(NAME)") count as unset.
  const env = (name: string): string | undefined => {
    const value = process.env[name]?.trim();
    return value && !/^\$\([A-Za-z0-9_.]+\)$/.test(value) ? value : undefined;
  };
  const flag = (name: string, fallback: boolean): boolean => {
    const value = env(name);
    if (value === undefined) return fallback;
    if (TRUE_VALUES.includes(value.toLowerCase())) return true;
    if (FALSE_VALUES.includes(value.toLowerCase())) return false;
    problems.push(`${name} must be true, false, 1, 0, yes, no, on or off (received "${value}").`);
    return fallback;
  };

  const parsed = MemoryCabinConfigSchema.safeParse(configured);
  if (!parsed.success) problems.push(`memoryCabin configuration is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}.`);
  const input = parsed.success ? parsed.data : disabled;
  const enabled = flag("MANSO_MEMORY_ENABLED", input.enabled);
  const result = MemoryCabinConfigSchema.safeParse({
    ...input,
    enabled,
    strict: flag("MANSO_MEMORY_STRICT", input.strict),
    readContext: flag("MANSO_MEMORY_READ_CONTEXT", input.readContext),
    root: env("MANSO_MEMORY_ROOT") ?? input.root,
    branch: env("MANSO_MEMORY_BRANCH") ?? input.branch,
    cacheDir: env("MANSO_MEMORY_CACHE_DIR") ?? input.cacheDir,
  });
  if (!result.success) problems.push(`Memory Cabin configuration is invalid: ${result.error.issues.map((issue) => issue.message).join("; ")}.`);
  else if (result.data.enabled && !result.data.root) problems.push("Enabled Memory Cabin requires MANSO_MEMORY_ROOT or memoryCabin.root.");
  if (result.success && problems.length === 0) return result.data;

  const message = problems.join(" ");
  const disabledByEnvironment = FALSE_VALUES.includes(env("MANSO_MEMORY_ENABLED")?.toLowerCase() ?? "");
  const requested = !disabledByEnvironment && (enabled
    || (typeof configured === "object" && configured !== null && (configured as { enabled?: unknown }).enabled === true));
  if (requested) throw new CliError(message);
  if (!warned.has(message)) {
    warned.add(message);
    console.warn(`[manso-memory] ${message} Memory Cabin is disabled for this run.`);
  }
  return disabled;
}
