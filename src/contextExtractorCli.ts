#!/usr/bin/env node
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import { ContextPackSchema } from "./domain/contextPack/schema.js";
import { runConfluenceImpact } from "./confluenceImpactCli.js";
import { runExtractTicket } from "./extractTicketCli.js";
import { runLinkedXrayTestExtraction } from "./linkedXrayTestExtractionCli.js";
import { createPhoenixTracedWorkflow, flushPhoenixTelemetry } from "./integrations/llm/telemetry/phoenix.js";
import { runPrChanges } from "./prChangesCli.js";
import { CliError, rejectInternalCliEntrypoint } from "./shared/cli.js";
import { parseCommonContextArgs, type CommonContextArgs } from "./shared/cliArgs.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import { runExtractXrayTests } from "./xrayTestExtractionCli.js";
import { runXrayTestReview } from "./xrayTestReviewCli.js";

async function main(): Promise<void> {
  const args = parseCommonContextArgs();
  const logProgress = createProgressLogger("context-extractor");

  if (args.help) {
    printHelp();
    return;
  }

  try {
    const config = await loadRuntimeConfig({
      ...(args.configPath ? { configPath: args.configPath } : {}),
    });
    const tracedRunContextExtractor = createPhoenixTracedWorkflow(
      (input: ParsedArgs) => runContextExtractor(input, logProgress),
      config.observability?.phoenix,
      {
        name: "task.context-extractor",
        attributes: {
          "workflow.name": "context-extractor",
          ...(args.issue ? { "workflow.issue": args.issue } : {}),
        },
        input: (input) => ({
          issue: input.issue,
          contextPath: input.contextPath,
          outDir: input.outDir,
          configPath: input.configPath,
        }),
        output: (output) => output,
      },
    );
    await tracedRunContextExtractor(args);
  } finally {
    await flushPhoenixTelemetry();
  }
}

export async function runContextExtractor(args: ParsedArgs, logProgress = createProgressLogger("context-extractor")): Promise<ContextExtractorResult> {
  if (!args.issue && !args.contextPath) {
    throw new CliError("Missing --issue or --context value.");
  }

  let contextPath = args.contextPath;
  if (!contextPath) {
    const result = await runExtractTicket({
      ...(args.issue ? { issue: args.issue } : {}),
      outDir: args.outDir,
      ...(args.configPath ? { configPath: args.configPath } : {}),
      help: false,
    }, logProgress);
    contextPath = result.contextPath;
  }

  const context = ContextPackSchema.parse(JSON.parse(await readFile(contextPath, "utf8")));
  logProgress(
    `Context ready for ${context.ticket.key}: ${context.confluencePages.length} Confluence page(s), ${context.xrayTestCases.length} Xray test(s), ${context.development.pullRequests.length} pull request(s).`,
  );

  let xrayDefinitionsPath: string | undefined;
  let xrayGenerationPath: string | undefined;
  if (context.confluencePages.length > 0) {
    await runConfluenceImpact({
      ...(args.issue ? { issue: args.issue } : {}),
      outDir: args.outDir,
      contextPath,
      ...(args.configPath ? { configPath: args.configPath } : {}),
      help: false,
    }, logProgress);
  } else {
    logProgress("Skipping Confluence extraction because no linked Confluence pages were found.");
  }

  if (context.xrayTestCases.length > 0) {
    const definitionsResult = await runExtractXrayTests({
      ...(args.issue ? { issue: args.issue } : {}),
      outDir: args.outDir,
      contextPath,
      ...(args.configPath ? { configPath: args.configPath } : {}),
      help: false,
    }, logProgress);
    xrayDefinitionsPath = definitionsResult?.jsonPath;
    await runXrayTestReview({
      ...(args.issue ? { issue: args.issue } : {}),
      outDir: args.outDir,
      contextPath,
      ...(xrayDefinitionsPath ? { xrayTestDefinitionsPath: xrayDefinitionsPath } : {}),
      ...(args.configPath ? { configPath: args.configPath } : {}),
      help: false,
    }, logProgress);
    const generationResult = await runLinkedXrayTestExtraction({
      ...(args.issue ? { issue: args.issue } : {}),
      outDir: args.outDir,
      contextPath,
      ...(xrayDefinitionsPath ? { xrayTestDefinitionsPath: xrayDefinitionsPath } : {}),
      ...(args.configPath ? { configPath: args.configPath } : {}),
      help: false,
    }, logProgress);
    xrayGenerationPath = generationResult?.jsonPath;
  } else {
    logProgress("Skipping linked Xray extraction and review because no linked Xray tests were found.");
  }

  if (context.development.pullRequests.length > 0) {
    await runPrChanges({
      ...(args.issue ? { issue: args.issue } : {}),
      outDir: args.outDir,
      contextPath,
      ...(args.configPath ? { configPath: args.configPath } : {}),
      help: false,
    }, logProgress);
  } else {
    logProgress("Skipping PR change extraction because no linked pull requests were found.");
  }

  logProgress("Context extraction workflow completed.");
  return {
    issueKey: context.ticket.key,
    contextPath,
    ...(xrayDefinitionsPath ? { xrayDefinitionsPath } : {}),
    ...(xrayGenerationPath ? { xrayGenerationPath } : {}),
  };
}

export type ParsedArgs = CommonContextArgs;

export interface ContextExtractorResult {
  issueKey: string;
  contextPath: string;
  xrayDefinitionsPath?: string;
  xrayGenerationPath?: string;
}

function printHelp(): void {
  console.log(`Context Extractor

Usage:
  context-extractor --issue ABC-123 --out ./out
  context-extractor --context ./out/ABC-123/context.json

Options:
  --issue <key>          Jira issue key to extract.
  --out <dir>            Output root directory. Defaults to ./out.
  --context <path>       Existing context.json to use instead of extracting Jira again.
  --config <path>        Optional JSON config for non-secret overrides.
  -h, --help             Show this help.
`);
}

rejectInternalCliEntrypoint(import.meta.url, "generate-xray-tests --issue <key> --out <dir>");
