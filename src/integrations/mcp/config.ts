import { z } from "zod";

/**
 * MCP server configuration (M11).
 *
 * Mirrors the Claude Agent SDK's `McpServerConfig` shape so resolution is a
 * near-identity mapping, while staying provider-neutral (a stdio server is also
 * forwarded to the Codex CLI). Lives in `.agents/manso.config.json` under
 * `mcpServers`, keyed by server name (e.g. "playwright", "figma").
 *
 * Secrets are NOT stored inline: `url`, `headers`, and `env` values support
 * `${ENV_VAR}` placeholders that are expanded from the process environment at
 * resolve time, so an API token lives in `.env` (gitignored), not the config.
 */

const McpStdioServerConfigSchema = z
  .object({
    type: z.literal("stdio").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const McpHttpServerConfigSchema = z
  .object({
    type: z.literal("http"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const McpSseServerConfigSchema = z
  .object({
    type: z.literal("sse"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** A single MCP server definition (stdio | http | sse). */
export const McpServerConfigSchema = z.union([
  McpHttpServerConfigSchema,
  McpSseServerConfigSchema,
  McpStdioServerConfigSchema,
]);

/** Map of server name → MCP server config. */
export const McpServersSchema = z.record(z.string(), McpServerConfigSchema);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpServers = z.infer<typeof McpServersSchema>;

export interface ResolveMcpServersResult {
  /** Resolved servers in the Claude-SDK shape, ready to pass to `query`. */
  servers: McpServers;
  /** Non-fatal issues — e.g. an `${ENV_VAR}` placeholder with no value. */
  warnings: string[];
}

const ENV_PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/g;

/**
 * Expand `${ENV_VAR}` placeholders in every server's url/headers/env from the
 * given environment. A placeholder with no matching variable is left literal
 * and recorded as a warning so the run does not silently send an empty secret.
 */
export function resolveMcpServers(
  servers: McpServers | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolveMcpServersResult {
  const warnings: string[] = [];
  if (!servers || Object.keys(servers).length === 0) {
    return { servers: {}, warnings };
  }

  const expand = (value: string, where: string): string =>
    value.replace(ENV_PLACEHOLDER, (whole, name: string) => {
      const replacement = env[name];
      if (replacement === undefined || replacement.length === 0) {
        warnings.push(`MCP ${where}: environment variable ${name} is not set; left "${whole}" unexpanded.`);
        return whole;
      }
      return replacement;
    });

  const expandRecord = (record: Record<string, string> | undefined, where: string): Record<string, string> | undefined => {
    if (!record) return undefined;
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expand(value, `${where}.${key}`)]));
  };

  const resolved: McpServers = {};
  for (const [name, config] of Object.entries(servers)) {
    if ("url" in config) {
      const headers = expandRecord(config.headers, `${name}.headers`);
      resolved[name] = {
        type: config.type,
        url: expand(config.url, `${name}.url`),
        ...(headers ? { headers } : {}),
      };
    } else {
      const envVars = expandRecord(config.env, `${name}.env`);
      resolved[name] = {
        ...(config.type ? { type: config.type } : {}),
        command: config.command,
        ...(config.args ? { args: config.args } : {}),
        ...(envVars ? { env: envVars } : {}),
      };
    }
  }

  return { servers: resolved, warnings };
}

/**
 * Convert resolved MCP servers into Codex CLI `mcp_servers` config overrides.
 * Codex's stdio transport is the broadly-supported one, so http/sse servers
 * are dropped here (still available to the Claude SDK runner).
 */
export function toCodexMcpConfig(servers: McpServers): Record<string, unknown> | undefined {
  const stdio = Object.entries(servers).filter(([, config]) => !("url" in config));
  if (stdio.length === 0) {
    return undefined;
  }
  const mcpServers: Record<string, unknown> = {};
  for (const [name, config] of stdio) {
    if ("url" in config) continue;
    mcpServers[name] = {
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      ...(config.env ? { env: config.env } : {}),
    };
  }
  return { mcp_servers: mcpServers };
}

/** Human-readable one-line-per-server summary for the implementation prompt. */
export function describeMcpServers(servers: McpServers): string[] {
  return Object.entries(servers).map(([name, config]) => {
    if ("url" in config) {
      return `- ${name} (${config.type}): ${config.url}`;
    }
    const args = config.args && config.args.length > 0 ? ` ${config.args.join(" ")}` : "";
    return `- ${name} (stdio): ${config.command}${args}`;
  });
}
