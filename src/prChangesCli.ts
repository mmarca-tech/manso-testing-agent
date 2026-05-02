#!/usr/bin/env node
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import { ContextPackSchema } from "./domain/contextPack/schema.js";
import { AzureDevOpsClient } from "./integrations/azureDevOps/client.js";
import { AzureDevOpsPullRequestDiffSource } from "./integrations/azureDevOps/pullRequestDiffSource.js";
import { OpenAiResponsesSummarizer } from "./integrations/openai/responsesSummarizer.js";
import { writePrChangesPack } from "./output/pr-changes/writer.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import { extractPrChanges } from "./workflows/pr-changes/extractor.js";

async function main(): Promise<void> {
  const args = parseCliArgs();
  const logProgress = createProgressLogger("summarize-pr-changes");

  if (args.help) {
    printHelp();
    return;
  }

  const contextPath = resolveContextPath(args);
  logProgress(`Loading context from ${contextPath}.`);
  const context = ContextPackSchema.parse(JSON.parse(await readFile(contextPath, "utf8")));
  logProgress(`Loaded context for ${context.ticket.key}: ${context.development.pullRequests.length} linked pull request(s).`);
  logProgress("Loading runtime configuration.");
  const config = await loadRuntimeConfig({
    ...(args.configPath ? { configPath: args.configPath } : {}),
  });

  if (!config.azureDevOps) {
    throw new CliError("Missing Azure DevOps token. Set AZURE_DEVOPS_PAT, AZURE_DEVOPS_TOKEN, or SYSTEM_ACCESSTOKEN.");
  }

  if (!config.openAi) {
    throw new CliError("Missing OpenAI config. Set OPENAI_API_KEY, and optionally OPENAI_MODEL.");
  }

  logProgress(`Using OpenAI model ${config.openAi.model}.`);
  const diffSource = new AzureDevOpsPullRequestDiffSource(new AzureDevOpsClient({ token: config.azureDevOps.token }));
  const summarizer = new OpenAiResponsesSummarizer({
    apiKey: config.openAi.apiKey,
    model: config.openAi.model,
    ...(config.openAi.baseUrl ? { baseUrl: config.openAi.baseUrl } : {}),
  });
  logProgress("Starting pull request change summary workflow.");
  const pack = await extractPrChanges(context, diffSource, summarizer, { sourceContextPath: contextPath, onProgress: logProgress });
  logProgress(`Writing PR changes outputs to ${dirname(contextPath)}.`);
  const result = await writePrChangesPack(pack, dirname(contextPath));

  console.log(`Wrote ${result.jsonPath}`);
  console.log(`Wrote ${result.markdownPath}`);
  if (pack.warnings.length > 0) {
    console.warn(`Completed with ${pack.warnings.length} warning(s). See pr-changes.json/pr-changes.md.`);
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
  console.log(`PR Changes Summarizer

Usage:
  summarize-pr-changes --issue ABC-123 --out ./out
  summarize-pr-changes --context ./out/ABC-123/context.json

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
