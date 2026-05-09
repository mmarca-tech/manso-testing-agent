#!/usr/bin/env node
import "dotenv/config";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import { AtlassianRestClient } from "./integrations/atlassianRest/client.js";
import { AtlassianRestSource } from "./integrations/atlassianRest/source.js";
import { writeContextPack } from "./output/context-pack/writer.js";
import { CliError, rejectInternalCliEntrypoint } from "./shared/cli.js";
import { parseCommonIssueArgs, type CommonIssueArgs } from "./shared/cliArgs.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import type { TicketSource } from "./workflows/ticket-context/ticketSource.js";
import { extractTicketContext } from "./workflows/ticket-context/extractor.js";

async function main(): Promise<void> {
  const args = parseCommonIssueArgs();
  const logProgress = createProgressLogger("extract-ticket");

  if (args.help) {
    printHelp();
    return;
  }

  await runExtractTicket(args);
}

export async function runExtractTicket(args: ParsedArgs, logProgress = createProgressLogger("extract-ticket")): Promise<{ contextPath: string; markdownPath: string }> {
  if (!args.issue) {
    throw new CliError("Missing required --issue value.");
  }

  logProgress("Loading runtime configuration.");
  const config = await loadRuntimeConfig({
    ...(args.configPath ? { configPath: args.configPath } : {}),
  });
  logProgress("Runtime configuration loaded.");

  const source = createTicketSource(config);

  try {
    logProgress(`Extracting Jira ticket ${args.issue}.`);
    const context = await extractTicketContext(args.issue, source);
    logProgress(
      `Extracted ${context.comments.length} comment(s), ${context.xrayTestCases.length} Xray test(s), ${context.development.pullRequests.length} pull request(s), and ${context.confluencePages.length} Confluence page(s).`,
    );
    logProgress(`Writing context pack to ${args.outDir}.`);
    const result = await writeContextPack(context, args.outDir);
    console.log(`Wrote ${result.jsonPath}`);
    console.log(`Wrote ${result.markdownPath}`);
    if (context.warnings.length > 0) {
      console.warn(`Completed with ${context.warnings.length} warning(s). See context.json/context.md.`);
    }
    return { contextPath: result.jsonPath, markdownPath: result.markdownPath };
  } finally {
    logProgress("Closing ticket source.");
    await source.close();
  }
}

export type ParsedArgs = CommonIssueArgs;

function printHelp(): void {
  console.log(`Jira Ticket Context Extractor

Usage:
  extract-ticket --issue ABC-123 --out ./out

Options:
  --issue <key>          Jira issue key to extract. Required.
  --out <dir>            Output root directory. Defaults to ./out.
  --config <path>        Optional JSON config for Jira REST settings.
  -h, --help             Show this help.
`);
}

function createTicketSource(config: Awaited<ReturnType<typeof loadRuntimeConfig>>): TicketSource {
  if (!config.jiraRest) {
    throw new CliError("Missing Jira REST config. Set JIRA_URL, JIRA_USERNAME, and JIRA_API_TOKEN.");
  }

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

  return new AtlassianRestSource({
    client,
    ...(config.jiraRest.jiraCloudId ? { jiraCloudId: config.jiraRest.jiraCloudId } : {}),
  });
}

rejectInternalCliEntrypoint(import.meta.url, "generate-xray-tests --issue <key> --out <dir>");
