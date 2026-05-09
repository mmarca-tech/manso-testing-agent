import { join } from "node:path";
import { parseArgs } from "node:util";
import { CliError } from "./cli.js";

export interface CommonContextArgs {
  issue?: string;
  outDir: string;
  contextPath?: string;
  configPath?: string;
  help: boolean;
}

export interface CommonIssueArgs {
  issue?: string;
  outDir: string;
  configPath?: string;
  help: boolean;
}

export const commonContextArgOptions = {
  issue: { type: "string" },
  out: { type: "string" },
  context: { type: "string" },
  config: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

export const commonIssueArgOptions = {
  issue: { type: "string" },
  out: { type: "string" },
  config: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

type ParsedValues = Record<string, string | boolean | string[] | undefined>;

export function parseCommonContextArgs(argv = process.argv.slice(2)): CommonContextArgs {
  const parsed = parseArgs({
    args: argv,
    options: commonContextArgOptions,
    allowPositionals: false,
  });

  return readCommonContextArgs(parsed.values as ParsedValues);
}

export function parseCommonIssueArgs(argv = process.argv.slice(2)): CommonIssueArgs {
  const parsed = parseArgs({
    args: argv,
    options: commonIssueArgOptions,
    allowPositionals: false,
  });

  return readCommonIssueArgs(parsed.values as ParsedValues);
}

export function readCommonContextArgs(values: ParsedValues): CommonContextArgs {
  const issue = asString(values.issue);
  const contextPath = asString(values.context);
  const configPath = asString(values.config);
  return {
    ...(issue ? { issue } : {}),
    outDir: asString(values.out) ?? "./out",
    ...(contextPath ? { contextPath } : {}),
    ...(configPath ? { configPath } : {}),
    help: asBoolean(values.help),
  };
}

export function readCommonIssueArgs(values: ParsedValues): CommonIssueArgs {
  const issue = asString(values.issue);
  const configPath = asString(values.config);
  return {
    ...(issue ? { issue } : {}),
    outDir: asString(values.out) ?? "./out",
    ...(configPath ? { configPath } : {}),
    help: asBoolean(values.help),
  };
}

export function resolveContextPath(args: { contextPath?: string; issue?: string; outDir: string }): string {
  if (args.contextPath) {
    return args.contextPath;
  }

  if (!args.issue) {
    throw new CliError("Missing --context or --issue value.");
  }

  return join(args.outDir, args.issue, "context.json");
}

export function parseNonNegativeInteger(value: string | undefined, optionName: string, defaultValue: number): number {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliError(`${optionName} must be a non-negative integer. Actual value: ${value}`);
  }

  return parsed;
}

export function asString(value: string | boolean | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asStringArray(value: string | boolean | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value;
  }

  return typeof value === "string" && value.length > 0 ? [value] : [];
}

export function asBoolean(value: string | boolean | string[] | undefined): boolean {
  return value === true;
}

export function coerceStringOptionValues(argv: string[], optionNames: string[]): string[] {
  const options = new Set(optionNames.map((name) => `--${name}`));
  const coerced: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === undefined) {
      continue;
    }
    if (options.has(value) && next !== undefined) {
      coerced.push(`${value}=${next}`);
      index += 1;
      continue;
    }

    coerced.push(value);
  }

  return coerced;
}
