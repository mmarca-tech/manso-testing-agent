#!/usr/bin/env node
import "dotenv/config";
import { parseArgs } from "node:util";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import { AtlassianRestClient } from "./integrations/atlassianRest/client.js";
import { AtlassianRestSource } from "./integrations/atlassianRest/source.js";
import { writeContextPack } from "./output/context-pack/writer.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import type { TicketSource } from "./workflows/ticket-context/ticketSource.js";
import { extractTicketContext } from "./workflows/ticket-context/extractor.js";

async function main(): Promise<void> {
  const args = parseCliArgs();
  const logProgress = createProgressLogger("extract-ticket");

  if (args.help) {
    printHelp();
    return;
  }

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
  } finally {
    logProgress("Closing ticket source.");
    await source.close();
  }
}

interface ParsedArgs {
  issue?: string;
  outDir: string;
  configPath?: string;
  help: boolean;
}

function parseCliArgs(): ParsedArgs {
  const parsed = parseArgs({
    options: {
      issue: { type: "string" },
      out: { type: "string" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  return {
    ...(parsed.values.issue ? { issue: parsed.values.issue } : {}),
    outDir: parsed.values.out ?? "./out",
    ...(parsed.values.config ? { configPath: parsed.values.config } : {}),
    help: parsed.values.help ?? false,
  };
}

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
