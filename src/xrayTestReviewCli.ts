#!/usr/bin/env node
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import { ContextPackSchema } from "./domain/contextPack/schema.js";
import { OpenAiXrayTestReviewer } from "./integrations/openai/xrayTestReviewer.js";
import { XrayCloudClient } from "./integrations/xray/client.js";
import { XrayCloudTestDefinitionSource } from "./integrations/xray/testDefinitionSource.js";
import { writeXrayTestReviewPack } from "./output/xray-test-review/writer.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import { extractXrayTestReview } from "./workflows/xray-test-review/extractor.js";

async function main(): Promise<void> {
  const args = parseCliArgs();
  const logProgress = createProgressLogger("review-xray-tests");

  if (args.help) {
    printHelp();
    return;
  }

  const contextPath = resolveContextPath(args);
  const outputDir = dirname(contextPath);
  logProgress(`Loading context from ${contextPath}.`);
  const context = ContextPackSchema.parse(JSON.parse(await readFile(contextPath, "utf8")));
  logProgress(`Loaded context for ${context.ticket.key}: ${context.xrayTestCases.length} linked Xray test(s).`);

  const config = await loadRuntimeConfig({
    ...(args.configPath ? { configPath: args.configPath } : {}),
  });

  if (context.xrayTestCases.length > 0 && !config.openAi) {
    throw new CliError("Missing OpenAI config. Set OPENAI_API_KEY, and optionally OPENAI_MODEL.");
  }

  const definitionSource = context.xrayTestCases.length > 0 && config.xray
    ? new XrayCloudTestDefinitionSource(
        new XrayCloudClient({
          baseUrl: config.xray.baseUrl,
          clientId: config.xray.clientId,
          clientSecret: config.xray.clientSecret,
        }),
      )
    : undefined;
  const reviewer = context.xrayTestCases.length > 0 && config.openAi
    ? new OpenAiXrayTestReviewer({
        apiKey: config.openAi.apiKey,
        model: config.openAi.model,
        ...(config.openAi.baseUrl ? { baseUrl: config.openAi.baseUrl } : {}),
      })
    : undefined;

  if (reviewer) {
    logProgress(`Using OpenAI model ${reviewer.model}.`);
    if (definitionSource) {
      logProgress(`Using Xray Cloud base URL ${config.xray?.baseUrl} for linked test definitions.`);
    } else if (context.xrayTestCases.length > 0) {
      logProgress("Xray Cloud config is missing; review will use linked test metadata from context.json only.");
    }
  } else {
    logProgress("No linked Xray tests found; writing empty review without calling the LLM.");
  }

  const pack = await extractXrayTestReview(context, reviewer, {
    sourceContextPath: contextPath,
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
}

interface ParsedArgs {
  issue?: string;
  outDir: string;
  contextPath?: string;
  configPath?: string;
  help: boolean;
}

function parseCliArgs(): ParsedArgs {
  const parsed = parseArgs({
    options: {
      issue: { type: "string" },
      out: { type: "string" },
      context: { type: "string" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  return {
    ...(parsed.values.issue ? { issue: parsed.values.issue } : {}),
    outDir: parsed.values.out ?? "./out",
    ...(parsed.values.context ? { contextPath: parsed.values.context } : {}),
    ...(parsed.values.config ? { configPath: parsed.values.config } : {}),
    help: parsed.values.help ?? false,
  };
}

function resolveContextPath(args: ParsedArgs): string {
  if (args.contextPath) {
    return args.contextPath;
  }

  if (!args.issue) {
    throw new CliError("Missing --context or --issue value.");
  }

  return join(args.outDir, args.issue, "context.json");
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
  --config <path>        Optional JSON config for non-secret overrides.
  -h, --help             Show this help.
`);
}

class CliError extends Error {}

main().catch((error: unknown) => {
  if (error instanceof CliError) {
    console.error(error.message);
  } else if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }

  process.exitCode = 1;
});
