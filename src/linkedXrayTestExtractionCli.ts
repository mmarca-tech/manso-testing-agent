#!/usr/bin/env node
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { ContextPackSchema } from "./domain/contextPack/schema.js";
import { writeXrayTestGenerationPack } from "./output/xray-test-generation/writer.js";
import { CliError, rejectInternalCliEntrypoint } from "./shared/cli.js";
import { asString, readCommonContextArgs, resolveContextPath, type CommonContextArgs } from "./shared/cliArgs.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import { buildLinkedXrayImplementationPack } from "./workflows/xray-test-generation/linkedXrayImplementationPack.js";
import {
  defaultXrayTestDefinitionsPath,
  readXrayTestDefinitionsPack,
  xrayTestDefinitionsPackExists,
} from "./workflows/xray-test-review/xrayTestDefinitionsPack.js";
import { runExtractXrayTests } from "./xrayTestExtractionCli.js";

async function main(): Promise<void> {
  const args = parseCliArgs();
  const logProgress = createProgressLogger("extract-linked-xray-tests");

  if (args.help) {
    printHelp();
    return;
  }

  await runLinkedXrayTestExtraction(args, logProgress);
}

export async function runLinkedXrayTestExtraction(args: ParsedArgs, logProgress = createProgressLogger("extract-linked-xray-tests")): Promise<{ issueKey: string; jsonPath: string; markdownPath: string } | undefined> {
  const contextPath = resolveContextPath(args);
  const outputDir = dirname(contextPath);
  logProgress(`Loading context from ${contextPath}.`);
  const context = ContextPackSchema.parse(JSON.parse(await readFile(contextPath, "utf8")));
  logProgress(`Loaded context for ${context.ticket.key}: ${context.xrayTestCases.length} linked Xray test(s).`);
  if (context.xrayTestCases.length === 0) {
    logProgress("No linked Xray tests found; skipping linked Xray extraction.");
    return undefined;
  }

  const definitionsPath = args.xrayTestDefinitionsPath ?? defaultXrayTestDefinitionsPath(contextPath);
  let definitionsPack = await xrayTestDefinitionsPackExists(definitionsPath)
    ? await readXrayTestDefinitionsPack(definitionsPath)
    : undefined;
  if (args.xrayTestDefinitionsPath && !definitionsPack) {
    throw new CliError(`Required Xray test definitions pack was not found: ${args.xrayTestDefinitionsPath}`);
  }
  if (!definitionsPack) {
    logProgress("Xray definitions pack was not found; extracting linked Xray definitions first.");
    const extractionResult = await runExtractXrayTests({
      ...(args.issue ? { issue: args.issue } : {}),
      outDir: args.outDir,
      contextPath,
      ...(args.configPath ? { configPath: args.configPath } : {}),
      help: false,
    }, logProgress);
    if (!extractionResult) {
      throw new CliError("No linked Xray tests were found to extract.");
    }
    definitionsPack = extractionResult.pack;
  } else {
    logProgress(`Using Xray definitions from ${definitionsPath}.`);
  }
  if (definitionsPack.ticket.key !== context.ticket.key) {
    throw new CliError(`Xray definitions pack ticket ${definitionsPack.ticket.key} does not match context ticket ${context.ticket.key}.`);
  }

  logProgress("Creating implementation pack from linked Xray tests.");
  const generationPack = buildLinkedXrayImplementationPack({
    context,
    definitions: definitionsPack.definitions,
    sourceContextPath: contextPath,
    definitionProvenance: definitionsPack.provenance.tools,
    definitionWarnings: definitionsPack.warnings,
  });
  const result = await writeXrayTestGenerationPack(generationPack, outputDir);
  console.log(`Wrote ${result.jsonPath}`);
  console.log(`Wrote ${result.markdownPath}`);
  if (generationPack.warnings.length > 0) {
    console.warn(`Completed with ${generationPack.warnings.length} warning(s). See xray-test-generation.json/xray-test-generation.md.`);
  }

  return { issueKey: context.ticket.key, jsonPath: result.jsonPath, markdownPath: result.markdownPath };
}

export interface ParsedArgs extends CommonContextArgs {
  xrayTestDefinitionsPath?: string;
}

function parseCliArgs(): ParsedArgs {
  const parsed = parseArgs({
    options: {
      issue: { type: "string" },
      out: { type: "string" },
      context: { type: "string" },
      "xray-test-definitions": { type: "string" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  const common = readCommonContextArgs(parsed.values);
  const xrayTestDefinitionsPath = asString(parsed.values["xray-test-definitions"]);
  return {
    ...common,
    ...(xrayTestDefinitionsPath ? { xrayTestDefinitionsPath } : {}),
  };
}

function printHelp(): void {
  console.log(`Linked Xray Test Extractor

Usage:
  extract-linked-xray-tests --issue ABC-123 --out ./out
  extract-linked-xray-tests --context ./out/ABC-123/context.json

Options:
  --issue <key>          Jira issue key whose ./out/<key>/context.json should be used.
  --out <dir>            Output root directory. Defaults to ./out.
  --context <path>       Explicit context.json path.
  --xray-test-definitions <path>
                         Optional xray-test-definitions.json path. Defaults next to context.json.
  --config <path>        Optional JSON config for non-secret overrides.
  -h, --help             Show this help.
`);
}

rejectInternalCliEntrypoint(import.meta.url, "implement-xray-tests --issue <key> --out <dir> --TestDesignEnabled false");
