#!/usr/bin/env node
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import { ContextPackSchema } from "./domain/contextPack/schema.js";
import { AzureDevOpsClient } from "./integrations/azureDevOps/client.js";
import { AzureDevOpsPullRequestDiffSource } from "./integrations/azureDevOps/pullRequestDiffSource.js";
import { createLlmTextClient } from "./integrations/llm/factory.js";
import { LlmPullRequestSummarizer } from "./integrations/llm/adapters/pullRequestSummarizer.js";
import { flushTelemetry } from "./integrations/llm/telemetry/observability.js";
import { writePrChangesPack } from "./output/pr-changes/writer.js";
import { CliError, rejectInternalCliEntrypoint } from "./shared/cli.js";
import { parseCommonContextArgs, resolveContextPath, type CommonContextArgs } from "./shared/cliArgs.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import { extractPrChanges } from "./workflows/pr-changes/extractor.js";

async function main(): Promise<void> {
  const args = parseCommonContextArgs();
  const logProgress = createProgressLogger("summarize-pr-changes");

  if (args.help) {
    printHelp();
    return;
  }

  try {
    await runPrChanges(args, logProgress);
  } finally {
    await flushTelemetry();
  }
}

export async function runPrChanges(args: ParsedArgs, logProgress = createProgressLogger("summarize-pr-changes")): Promise<{ jsonPath: string; markdownPath: string } | undefined> {
  const contextPath = resolveContextPath(args);
  logProgress(`Loading context from ${contextPath}.`);
  const context = ContextPackSchema.parse(JSON.parse(await readFile(contextPath, "utf8")));
  logProgress(`Loaded context for ${context.ticket.key}: ${context.development.pullRequests.length} linked pull request(s).`);
  if (context.development.pullRequests.length === 0) {
    logProgress("No linked pull requests found; skipping pull request change extraction.");
    return undefined;
  }

  logProgress("Loading runtime configuration.");
  const config = await loadRuntimeConfig({
    ...(args.configPath ? { configPath: args.configPath } : {}),
  });

  if (!config.azureDevOps) {
    throw new CliError("Missing Azure DevOps token. Set AZURE_DEVOPS_PAT, AZURE_DEVOPS_TOKEN, or SYSTEM_ACCESSTOKEN.");
  }

  if (!config.llm) {
    throw new CliError("Missing LLM config. Set LLM_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.");
  }

  const llmClient = createLlmTextClient(config.llm, { telemetry: config.observability?.telemetry });
  logProgress(`Using ${llmClient.provider} model ${llmClient.model}.`);
  const diffSource = new AzureDevOpsPullRequestDiffSource(new AzureDevOpsClient({ token: config.azureDevOps.token }));
  const summarizer = new LlmPullRequestSummarizer({ client: llmClient });
  logProgress("Starting pull request change summary workflow.");
  const pack = await extractPrChanges(context, diffSource, summarizer, { sourceContextPath: contextPath, onProgress: logProgress });
  logProgress(`Writing PR changes outputs to ${dirname(contextPath)}.`);
  const result = await writePrChangesPack(pack, dirname(contextPath));

  console.log(`Wrote ${result.jsonPath}`);
  console.log(`Wrote ${result.markdownPath}`);
  if (pack.warnings.length > 0) {
    console.warn(`Completed with ${pack.warnings.length} warning(s). See pr-changes.json/pr-changes.md.`);
  }
  return { jsonPath: result.jsonPath, markdownPath: result.markdownPath };
}

export type ParsedArgs = CommonContextArgs;

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

rejectInternalCliEntrypoint(import.meta.url, "generate-xray-tests --issue <key> --out <dir>");
