#!/usr/bin/env node
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import { ContextPackSchema } from "./domain/contextPack/schema.js";
import type { XrayTestDefinitionsPack } from "./domain/xrayTestDefinitions/schema.js";
import { XrayCloudClient } from "./integrations/xray/client.js";
import { XrayCloudTestDefinitionSource } from "./integrations/xray/testDefinitionSource.js";
import { writeXrayTestDefinitionsPack } from "./output/xray-test-definitions/writer.js";
import { CliError, rejectInternalCliEntrypoint } from "./shared/cli.js";
import { parseCommonContextArgs, resolveContextPath, type CommonContextArgs } from "./shared/cliArgs.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import { buildXrayTestDefinitionsPack } from "./workflows/xray-test-review/xrayTestDefinitionsPack.js";

async function main(): Promise<void> {
  const args = parseCommonContextArgs();
  const logProgress = createProgressLogger("extract-xray-tests");

  if (args.help) {
    printHelp();
    return;
  }

  await runExtractXrayTests(args, logProgress);
}

export type ParsedArgs = CommonContextArgs;

export async function runExtractXrayTests(
  args: ParsedArgs,
  logProgress = createProgressLogger("extract-xray-tests"),
): Promise<{ issueKey: string; jsonPath: string; markdownPath: string; pack: XrayTestDefinitionsPack } | undefined> {
  const contextPath = resolveContextPath(args);
  const outputDir = dirname(contextPath);
  logProgress(`Loading context from ${contextPath}.`);
  const context = ContextPackSchema.parse(JSON.parse(await readFile(contextPath, "utf8")));
  logProgress(`Loaded context for ${context.ticket.key}: ${context.xrayTestCases.length} linked Xray test(s).`);
  if (context.xrayTestCases.length === 0) {
    logProgress("No linked Xray tests found; skipping Xray definition extraction.");
    return undefined;
  }

  logProgress("Loading runtime configuration.");
  const config = await loadRuntimeConfig({
    ...(args.configPath ? { configPath: args.configPath } : {}),
  });
  if (!config.xray) {
    throw new CliError("Missing Xray Cloud config. Set XRAY_BASE_URL, XRAY_CLIENT_ID, and XRAY_CLIENT_SECRET.");
  }

  logProgress(`Fetching expanded definitions for ${context.xrayTestCases.length} linked Xray test(s).`);
  const definitionSource = new XrayCloudTestDefinitionSource(
    new XrayCloudClient({
      baseUrl: config.xray.baseUrl,
      clientId: config.xray.clientId,
      clientSecret: config.xray.clientSecret,
    }),
  );
  const definitions = await definitionSource.getTestDefinitions(context.xrayTestCases);
  const pack = buildXrayTestDefinitionsPack({
    context,
    definitions,
    sourceContextPath: contextPath,
    tools: definitionSource.getProvenance(),
    warnings: definitionSource.getWarnings(),
  });

  logProgress(`Writing Xray definition outputs to ${outputDir}.`);
  const result = await writeXrayTestDefinitionsPack(pack, outputDir);
  console.log(`Wrote ${result.jsonPath}`);
  console.log(`Wrote ${result.markdownPath}`);
  if (pack.warnings.length > 0) {
    console.warn(`Completed with ${pack.warnings.length} warning(s). See xray-test-definitions.json/xray-test-definitions.md.`);
  }

  return { issueKey: context.ticket.key, jsonPath: result.jsonPath, markdownPath: result.markdownPath, pack };
}

function printHelp(): void {
  console.log(`Xray Test Definition Extractor

Usage:
  extract-xray-tests --issue ABC-123 --out ./out
  extract-xray-tests --context ./out/ABC-123/context.json

Options:
  --issue <key>          Jira issue key whose ./out/<key>/context.json should be used.
  --out <dir>            Output root directory. Defaults to ./out.
  --context <path>       Explicit context.json path.
  --config <path>        Optional JSON config for non-secret overrides.
  -h, --help             Show this help.
`);
}

rejectInternalCliEntrypoint(import.meta.url, "generate-xray-tests --issue <key> --out <dir>");
