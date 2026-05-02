#!/usr/bin/env node
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import { ContextPackSchema } from "./domain/contextPack/schema.js";
import { AtlassianRestClient } from "./integrations/atlassianRest/client.js";
import { ConfluenceRestPageSource } from "./integrations/confluence/pageSource.js";
import { OpenAiConfluenceImpactSummarizer } from "./integrations/openai/confluenceImpactSummarizer.js";
import { writeConfluenceImpactPack } from "./output/confluence-impact/writer.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import { extractConfluenceImpact } from "./workflows/confluence-impact/extractor.js";

const CONFLUENCE_REST_DISABLED_MESSAGE =
  "Confluence impact generation skipped because CONFLUENCE_ENABLED=false. No confluence-impact.json/confluence-impact.md files were written.";

async function main(): Promise<void> {
  const args = parseCliArgs();
  const logProgress = createProgressLogger("summarize-confluence-impact");

  if (args.help) {
    printHelp();
    return;
  }

  const contextPath = resolveContextPath(args);
  if (isExplicitlyFalse(process.env.CONFLUENCE_ENABLED)) {
    logProgress(CONFLUENCE_REST_DISABLED_MESSAGE);
    console.warn(CONFLUENCE_REST_DISABLED_MESSAGE);
    return;
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
    return;
  }

  if (!config.openAi) {
    throw new CliError("Missing OpenAI config. Set OPENAI_API_KEY, and optionally OPENAI_MODEL.");
  }

  logProgress(`Loading context from ${contextPath}.`);
  const context = ContextPackSchema.parse(JSON.parse(await readFile(contextPath, "utf8")));
  logProgress(`Loaded context for ${context.ticket.key}: ${context.confluencePages.length} linked Confluence page(s).`);
  logProgress(`Using OpenAI model ${config.openAi.model}.`);
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
  const summarizer = new OpenAiConfluenceImpactSummarizer({
    apiKey: config.openAi.apiKey,
    model: config.openAi.model,
    ...(config.openAi.baseUrl ? { baseUrl: config.openAi.baseUrl } : {}),
  });
  logProgress("Starting Confluence impact workflow.");
  const pack = await extractConfluenceImpact(context, pageSource, summarizer, { sourceContextPath: contextPath, onProgress: logProgress });
  logProgress(`Writing Confluence impact outputs to ${dirname(contextPath)}.`);
  const result = await writeConfluenceImpactPack(pack, dirname(contextPath));

  console.log(`Wrote ${result.jsonPath}`);
  console.log(`Wrote ${result.markdownPath}`);
  if (pack.warnings.length > 0) {
    console.warn(`Completed with ${pack.warnings.length} warning(s). See confluence-impact.json/confluence-impact.md.`);
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

class CliError extends Error {}

function isExplicitlyFalse(value: string | undefined): boolean {
  return value !== undefined && ["0", "false", "no", "off"].includes(value.toLowerCase());
}

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
