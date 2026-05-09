#!/usr/bin/env node
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import { ContextPackSchema } from "./domain/contextPack/schema.js";
import { createLlmTextClient } from "./integrations/llm/factory.js";
import { LlmXrayTestReviewer } from "./integrations/llm/adapters/xrayTestReviewer.js";
import { flushPhoenixTelemetry } from "./integrations/llm/telemetry/phoenix.js";
import { XrayCloudClient } from "./integrations/xray/client.js";
import { XrayCloudTestDefinitionSource } from "./integrations/xray/testDefinitionSource.js";
import { writeXrayTestReviewPack } from "./output/xray-test-review/writer.js";
import { CliError, rejectInternalCliEntrypoint } from "./shared/cli.js";
import { asString, readCommonContextArgs, resolveContextPath, type CommonContextArgs } from "./shared/cliArgs.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import { extractXrayTestReview } from "./workflows/xray-test-review/extractor.js";
import {
  defaultXrayTestDefinitionsPath,
  readXrayTestDefinitionsPack,
  xrayTestDefinitionsPackExists,
} from "./workflows/xray-test-review/xrayTestDefinitionsPack.js";

async function main(): Promise<void> {
  const args = parseCliArgs();
  const logProgress = createProgressLogger("review-xray-tests");

  if (args.help) {
    printHelp();
    return;
  }

  try {
    await runXrayTestReview(args, logProgress);
  } finally {
    await flushPhoenixTelemetry();
  }
}

export async function runXrayTestReview(args: ParsedArgs, logProgress = createProgressLogger("review-xray-tests")): Promise<{ jsonPath: string; markdownPath: string } | undefined> {
  const contextPath = resolveContextPath(args);
  const outputDir = dirname(contextPath);
  logProgress(`Loading context from ${contextPath}.`);
  const context = ContextPackSchema.parse(JSON.parse(await readFile(contextPath, "utf8")));
  logProgress(`Loaded context for ${context.ticket.key}: ${context.xrayTestCases.length} linked Xray test(s).`);
  if (context.xrayTestCases.length === 0) {
    logProgress("No linked Xray tests found; skipping Xray test review.");
    return undefined;
  }

  const config = await loadRuntimeConfig({
    ...(args.configPath ? { configPath: args.configPath } : {}),
  });

  if (context.xrayTestCases.length > 0 && !config.llm) {
    throw new CliError("Missing LLM config. Set LLM_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.");
  }

  const definitionsPath = args.xrayTestDefinitionsPath ?? defaultXrayTestDefinitionsPath(contextPath);
  const hasDefinitionsPack = context.xrayTestCases.length > 0 && await xrayTestDefinitionsPackExists(definitionsPath);
  if (args.xrayTestDefinitionsPath && !hasDefinitionsPack) {
    throw new CliError(`Required Xray test definitions pack was not found: ${args.xrayTestDefinitionsPath}`);
  }
  const definitionsPack = hasDefinitionsPack ? await readXrayTestDefinitionsPack(definitionsPath) : undefined;
  if (definitionsPack && definitionsPack.ticket.key !== context.ticket.key) {
    throw new CliError(`Xray definitions pack ticket ${definitionsPack.ticket.key} does not match context ticket ${context.ticket.key}.`);
  }

  const definitionSource = context.xrayTestCases.length > 0 && !definitionsPack && config.xray
    ? new XrayCloudTestDefinitionSource(
        new XrayCloudClient({
          baseUrl: config.xray.baseUrl,
          clientId: config.xray.clientId,
          clientSecret: config.xray.clientSecret,
        }),
      )
    : undefined;
  const llmClient =
    context.xrayTestCases.length > 0 && config.llm
      ? createLlmTextClient(config.llm, { phoenixTelemetry: config.observability?.phoenix })
      : undefined;
  const reviewer = llmClient
    ? new LlmXrayTestReviewer({
        client: llmClient,
      })
    : undefined;

  if (reviewer) {
    logProgress(`Using ${reviewer.provider} model ${reviewer.model}.`);
    if (definitionsPack) {
      logProgress(`Using Xray definitions from ${definitionsPath}.`);
    } else if (definitionSource) {
      logProgress(`Using Xray Cloud base URL ${config.xray?.baseUrl} for linked test definitions.`);
    } else if (context.xrayTestCases.length > 0) {
      logProgress("Xray Cloud config is missing; review will use linked test metadata from context.json only.");
    }
  } else {
    logProgress("No linked Xray tests found; writing empty review without calling the LLM.");
  }

  const pack = await extractXrayTestReview(context, reviewer, {
    sourceContextPath: contextPath,
    ...(definitionsPack
      ? {
          testDefinitions: definitionsPack.definitions,
          definitionProvenance: definitionsPack.provenance.tools,
          definitionWarnings: definitionsPack.warnings,
        }
      : {}),
    ...(definitionSource ? { definitionSource } : {}),
    onProgress: logProgress,
  });
  logProgress(`Writing Xray test review outputs to ${outputDir}.`);
  const result = await writeXrayTestReviewPack(pack, outputDir);

  console.log(`Wrote ${result.jsonPath}`);
  console.log(`Wrote ${result.markdownPath}`);
  if (pack.warnings.length > 0) {
    console.warn(`Completed with ${pack.warnings.length} warning(s). See xray-test-review.json/xray-test-review.md.`);
  }
  return { jsonPath: result.jsonPath, markdownPath: result.markdownPath };
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
  console.log(`Xray Test Review

Usage:
  review-xray-tests --issue ABC-123 --out ./out
  review-xray-tests --context ./out/ABC-123/context.json

Options:
  --issue <key>          Jira issue key whose ./out/<key>/context.json should be used.
  --out <dir>            Output root directory. Defaults to ./out.
  --context <path>       Explicit context.json path.
  --xray-test-definitions <path>
                         Optional xray-test-definitions.json path. Defaults next to context.json when present.
  --config <path>        Optional JSON config for non-secret overrides.
  -h, --help             Show this help.
`);
}

rejectInternalCliEntrypoint(import.meta.url, "generate-xray-tests --issue <key> --out <dir>");
