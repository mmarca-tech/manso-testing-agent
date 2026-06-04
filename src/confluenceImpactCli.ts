#!/usr/bin/env node
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import { ContextPackSchema } from "./domain/contextPack/schema.js";
import { AtlassianRestClient } from "./integrations/atlassianRest/client.js";
import { ConfluenceRestPageSource } from "./integrations/confluence/pageSource.js";
import { LlmConfluenceImpactSummarizer } from "./integrations/llm/adapters/confluenceImpactSummarizer.js";
import { createLlmTextClient } from "./integrations/llm/factory.js";
import { flushTelemetry } from "./integrations/llm/telemetry/observability.js";
import { writeConfluenceImpactPack } from "./output/confluence-impact/writer.js";
import { CliError, rejectInternalCliEntrypoint } from "./shared/cli.js";
import { parseCommonContextArgs, resolveContextPath, type CommonContextArgs } from "./shared/cliArgs.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import { extractConfluenceImpact } from "./workflows/confluence-impact/extractor.js";

const CONFLUENCE_REST_DISABLED_MESSAGE =
  "Confluence impact generation skipped because CONFLUENCE_ENABLED=false. No confluence-impact.json/confluence-impact.md files were written.";

async function main(): Promise<void> {
  const args = parseCommonContextArgs();
  const logProgress = createProgressLogger("summarize-confluence-impact");

  if (args.help) {
    printHelp();
    return;
  }

  try {
    await runConfluenceImpact(args, logProgress);
  } finally {
    await flushTelemetry();
  }
}

export async function runConfluenceImpact(args: ParsedArgs, logProgress = createProgressLogger("summarize-confluence-impact")): Promise<{ jsonPath: string; markdownPath: string } | undefined> {
  const contextPath = resolveContextPath(args);
  if (isExplicitlyFalse(process.env.CONFLUENCE_ENABLED)) {
    logProgress(CONFLUENCE_REST_DISABLED_MESSAGE);
    console.warn(CONFLUENCE_REST_DISABLED_MESSAGE);
    return undefined;
  }

  logProgress(`Loading context from ${contextPath}.`);
  const context = ContextPackSchema.parse(JSON.parse(await readFile(contextPath, "utf8")));
  logProgress(`Loaded context for ${context.ticket.key}: ${context.confluencePages.length} linked Confluence page(s).`);
  if (context.confluencePages.length === 0) {
    logProgress("No linked Confluence pages found; skipping Confluence impact extraction.");
    return undefined;
  }

  logProgress("Loading runtime configuration.");
  const config = await loadRuntimeConfig({
    ...(args.configPath ? { configPath: args.configPath } : {}),
  });

  if (!config.jiraRest) {
    throw new CliError("Missing Jira/Confluence config. Set JIRA_URL, JIRA_USERNAME, and JIRA_API_TOKEN.");
  }

  if (!config.jiraRest.includeConfluence) {
    logProgress(CONFLUENCE_REST_DISABLED_MESSAGE);
    console.warn(CONFLUENCE_REST_DISABLED_MESSAGE);
    return undefined;
  }

  if (!config.llm) {
    throw new CliError("Missing LLM config. Set LLM_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.");
  }

  const llmClient = createLlmTextClient(config.llm, { telemetry: config.observability?.telemetry });
  logProgress(`Using ${llmClient.provider} model ${llmClient.model}.`);
  const client = new AtlassianRestClient({
    jira: {
      baseUrl: config.jiraRest.jiraUrl,
      username: config.jiraRest.jiraUsername,
      apiToken: config.jiraRest.jiraApiToken,
    },
    ...(config.jiraRest.includeConfluence &&
    config.jiraRest.confluenceUrl &&
    config.jiraRest.confluenceUsername &&
    config.jiraRest.confluenceApiToken
      ? {
          confluence: {
            baseUrl: config.jiraRest.confluenceUrl,
            username: config.jiraRest.confluenceUsername,
            apiToken: config.jiraRest.confluenceApiToken,
          },
        }
      : {}),
  });
  const pageSource = new ConfluenceRestPageSource(client);
  const summarizer = new LlmConfluenceImpactSummarizer({ client: llmClient });
  logProgress("Starting Confluence impact workflow.");
  const pack = await extractConfluenceImpact(context, pageSource, summarizer, { sourceContextPath: contextPath, onProgress: logProgress });
  logProgress(`Writing Confluence impact outputs to ${dirname(contextPath)}.`);
  const result = await writeConfluenceImpactPack(pack, dirname(contextPath));

  console.log(`Wrote ${result.jsonPath}`);
  console.log(`Wrote ${result.markdownPath}`);
  if (pack.warnings.length > 0) {
    console.warn(`Completed with ${pack.warnings.length} warning(s). See confluence-impact.json/confluence-impact.md.`);
  }
  return { jsonPath: result.jsonPath, markdownPath: result.markdownPath };
}

export type ParsedArgs = CommonContextArgs;

function printHelp(): void {
  console.log(`Confluence Impact Summarizer

Usage:
  summarize-confluence-impact --issue ABC-123 --out ./out
  summarize-confluence-impact --context ./out/ABC-123/context.json

Options:
  --issue <key>          Jira issue key whose ./out/<key>/context.json should be used.
  --out <dir>            Output root directory. Defaults to ./out.
  --context <path>       Explicit context.json path.
  --config <path>        Optional JSON config for non-secret overrides.
  -h, --help             Show this help.
`);
}

function isExplicitlyFalse(value: string | undefined): boolean {
  return value !== undefined && ["0", "false", "no", "off"].includes(value.toLowerCase());
}

rejectInternalCliEntrypoint(import.meta.url, "generate-xray-tests --issue <key> --out <dir>");
