#!/usr/bin/env node
import "dotenv/config";
import { parseArgs } from "node:util";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import { AtlassianRestClient } from "./integrations/atlassianRest/client.js";
import { JiraReleaseNotesUpdater } from "./integrations/atlassianRest/releaseNotesUpdater.js";
import type { JiraReleaseNotesFieldFormat } from "./integrations/atlassianRest/releaseNotesUpdater.js";
import { AtlassianRestSource } from "./integrations/atlassianRest/source.js";
import { createLlmTextClient } from "./integrations/llm/factory.js";
import { LlmReleaseNotesSummarizer } from "./integrations/llm/adapters/releaseNotesSummarizer.js";
import { createPhoenixTracedWorkflow, flushPhoenixTelemetry } from "./integrations/llm/telemetry/phoenix.js";
import { renderReleaseNotesMarkdown } from "./output/release-notes/renderer.js";
import { writeReleaseNotesPack } from "./output/release-notes/writer.js";
import { CliError, handleCliError, isCliEntrypoint } from "./shared/cli.js";
import { asString, parseNonNegativeInteger } from "./shared/cliArgs.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import { extractReleaseNotes } from "./workflows/release-notes/extractor.js";
import type { TicketSource } from "./workflows/ticket-context/ticketSource.js";

async function main(): Promise<void> {
  const args = parseCliArgs();
  const logProgress = createProgressLogger("generate-release-notes");

  if (args.help) {
    printHelp();
    return;
  }

  try {
    const config = await loadRuntimeConfig({
      ...(args.configPath ? { configPath: args.configPath } : {}),
    });
    const tracedReleaseNotes = createPhoenixTracedWorkflow(
      (input: ParsedArgs) => runReleaseNotes(input, logProgress),
      config.observability?.phoenix,
      {
        name: "workflow.generate-release-notes",
        attributes: {
          "workflow.name": "generate-release-notes",
          ...(args.issue ? { "workflow.issue": args.issue } : {}),
          "workflow.no_upload": args.noUpload === true,
        },
        input: (input) => ({
          issue: input.issue,
          outDir: input.outDir,
          configPath: input.configPath,
          maxLinkedTickets: input.maxLinkedTickets,
          releaseNotesField: input.releaseNotesField,
          fieldFormat: input.fieldFormat,
          noUpload: input.noUpload,
        }),
        output: (output) => output,
      },
    );
    await tracedReleaseNotes(args);
  } finally {
    await flushPhoenixTelemetry();
  }
}

export async function runReleaseNotes(
  args: ParsedArgs,
  logProgress = createProgressLogger("generate-release-notes"),
): Promise<{ jsonPath: string; markdownPath: string }> {
  if (!args.issue) {
    throw new CliError("Missing required --issue value.");
  }

  logProgress("Loading runtime configuration.");
  const config = await loadRuntimeConfig({
    ...(args.configPath ? { configPath: args.configPath } : {}),
  });

  if (!config.jiraRest) {
    throw new CliError("Missing Jira REST config. Set JIRA_URL, JIRA_USERNAME, and JIRA_API_TOKEN.");
  }

  if (!config.llm) {
    throw new CliError("Missing LLM config. Set LLM_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.");
  }

  const llmClient = createLlmTextClient(config.llm, { phoenixTelemetry: config.observability?.phoenix });
  logProgress(`Using ${llmClient.provider} model ${llmClient.model}.`);
  const client = createAtlassianClient(config);
  const source = createTicketSource(config, client);
  const summarizer = new LlmReleaseNotesSummarizer({ client: llmClient });

  try {
    logProgress(`Starting release notes workflow for ${args.issue}.`);
    const pack = await extractReleaseNotes(args.issue, source, summarizer, {
      ...(args.maxLinkedTickets !== undefined ? { maxLinkedTickets: args.maxLinkedTickets } : {}),
      onProgress: logProgress,
    });
    logProgress(`Writing release notes outputs to ${args.outDir}.`);
    const result = await writeReleaseNotesPack(pack, args.outDir);

    console.log(`Wrote ${result.jsonPath}`);
    console.log(`Wrote ${result.markdownPath}`);
    const releaseNotesField = args.releaseNotesField ?? "customfield_11101";
    if (args.noUpload !== true) {
      logProgress(`Uploading release notes to ${args.issue} field ${releaseNotesField}.`);
      const updater = new JiraReleaseNotesUpdater({
        client,
        fieldId: releaseNotesField,
        fieldFormat: args.fieldFormat ?? "auto",
      });
      await updater.update(args.issue, renderReleaseNotesMarkdown(pack));
      console.log(`Updated ${args.issue} ${releaseNotesField}`);
      for (const warning of updater.getWarnings()) {
        console.warn(`${warning.section}${warning.toolName ? `/${warning.toolName}` : ""}: ${warning.message}`);
      }
    } else {
      logProgress("Skipping Jira upload because --no-upload was provided.");
    }
    if (pack.warnings.length > 0) {
      console.warn(`Completed with ${pack.warnings.length} warning(s). See release-notes.json/release-notes.md.`);
    }
    return { jsonPath: result.jsonPath, markdownPath: result.markdownPath };
  } finally {
    logProgress("Closing ticket source.");
    await source.close();
  }
}

export interface ParsedArgs {
  issue?: string;
  outDir: string;
  configPath?: string;
  maxLinkedTickets?: number;
  releaseNotesField?: string;
  fieldFormat?: JiraReleaseNotesFieldFormat;
  noUpload?: boolean;
  help: boolean;
}

function parseCliArgs(argv = process.argv.slice(2)): ParsedArgs {
  const parsed = parseArgs({
    args: argv,
    options: {
      issue: { type: "string" },
      out: { type: "string" },
      config: { type: "string" },
      "max-linked": { type: "string" },
      "release-notes-field": { type: "string" },
      "field-format": { type: "string" },
      "no-upload": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  const issue = asString(parsed.values.issue);
  const configPath = asString(parsed.values.config);
  const maxLinked = asString(parsed.values["max-linked"]);
  const fieldFormat = parseFieldFormat(asString(parsed.values["field-format"]));

  return {
    ...(issue ? { issue } : {}),
    outDir: asString(parsed.values.out) ?? "./out",
    ...(configPath ? { configPath } : {}),
    ...(maxLinked ? { maxLinkedTickets: parseNonNegativeInteger(maxLinked, "--max-linked", 0) } : {}),
    releaseNotesField: asString(parsed.values["release-notes-field"]) ?? "customfield_11101",
    fieldFormat,
    noUpload: parsed.values["no-upload"] === true,
    help: parsed.values.help === true,
  };
}

function printHelp(): void {
  console.log(`Release Notes Generator

Usage:
  generate-release-notes --issue ITSM-1234 --out ./out

Options:
  --issue <key>          Jira release issue key. Required.
  --out <dir>            Output root directory. Defaults to ./out.
  --config <path>        Optional JSON config for non-secret overrides.
  --max-linked <number>  Optional cap for linked Jira tickets to extract.
  --release-notes-field <field>
                         Jira custom field to update. Defaults to customfield_11101.
  --field-format <format>
                         Jira field value format: auto, text, or adf. Defaults to auto.
  --no-upload            Write local files only; do not update Jira.
  -h, --help             Show this help.
`);
}

function parseFieldFormat(value: string | undefined): JiraReleaseNotesFieldFormat {
  if (value === undefined || value === "auto" || value === "text" || value === "adf") {
    return value ?? "auto";
  }

  throw new CliError(`--field-format must be one of: auto, text, adf. Actual value: ${value}`);
}

function createAtlassianClient(config: Awaited<ReturnType<typeof loadRuntimeConfig>>): AtlassianRestClient {
  if (!config.jiraRest) {
    throw new CliError("Missing Jira REST config. Set JIRA_URL, JIRA_USERNAME, and JIRA_API_TOKEN.");
  }

  return new AtlassianRestClient({
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
}

function createTicketSource(config: Awaited<ReturnType<typeof loadRuntimeConfig>>, client: AtlassianRestClient): TicketSource {
  if (!config.jiraRest) {
    throw new CliError("Missing Jira REST config. Set JIRA_URL, JIRA_USERNAME, and JIRA_API_TOKEN.");
  }

  return new AtlassianRestSource({
    client,
    ...(config.jiraRest.jiraCloudId ? { jiraCloudId: config.jiraRest.jiraCloudId } : {}),
  });
}

if (isCliEntrypoint(import.meta.url)) {
  main().catch(handleCliError);
}
