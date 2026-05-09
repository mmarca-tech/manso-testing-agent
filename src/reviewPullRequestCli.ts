#!/usr/bin/env node
import "dotenv/config";
import { parseArgs } from "node:util";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import type { Warning } from "./domain/contextPack/schema.js";
import { AtlassianRestClient } from "./integrations/atlassianRest/client.js";
import { AtlassianRestSource } from "./integrations/atlassianRest/source.js";
import { AzureDevOpsClient } from "./integrations/azureDevOps/client.js";
import { AzureDevOpsPullRequestDiffSource } from "./integrations/azureDevOps/pullRequestDiffSource.js";
import { createLlmTextClient } from "./integrations/llm/factory.js";
import { LlmPullRequestCodeReviewer } from "./integrations/llm/adapters/pullRequestCodeReviewer.js";
import { createPhoenixTracedWorkflow, flushPhoenixTelemetry } from "./integrations/llm/telemetry/phoenix.js";
import {
  AzureDevOpsPullRequestCommentSink,
  AzureDevOpsPullRequestReviewSource,
  pullRequestToContextPullRequest,
  resolveAzureDevOpsPullRequestRefFromEnvironment,
} from "./integrations/azureDevOps/pullRequestReview.js";
import type { AzureDevOpsPullRequestRef } from "./integrations/azureDevOps/pullRequestReview.js";
import { renderCodeReviewComment } from "./output/code-review/renderer.js";
import { writeCodeReviewPack } from "./output/code-review/writer.js";
import { CliError, handleCliError, isCliEntrypoint } from "./shared/cli.js";
import { asBoolean, asString, parseNonNegativeInteger } from "./shared/cliArgs.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import { extractCodeReview } from "./workflows/code-review/extractor.js";
import { detectJiraIssueKey } from "./workflows/code-review/ticketDetection.js";
import { extractTicketContext } from "./workflows/ticket-context/extractor.js";

async function main(): Promise<void> {
  const args = parseCliArgs();
  const logProgress = createProgressLogger("review-pull-request");

  if (args.help) {
    printHelp();
    return;
  }

  try {
    const config = await loadRuntimeConfig({
      ...(args.configPath ? { configPath: args.configPath } : {}),
    });
    const tracedReview = createPhoenixTracedWorkflow(
      (input: ParsedArgs) => runPullRequestCodeReview(input, logProgress),
      config.observability?.phoenix,
      {
        name: "workflow.review-pull-request",
        attributes: {
          "workflow.name": "review-pull-request",
          ...(args.ticketKey ? { "workflow.issue": args.ticketKey } : {}),
          "workflow.no_comment": args.noComment,
        },
        input: (input) => ({
          organization: input.organization,
          project: input.project,
          repository: input.repository,
          pullRequestId: input.pullRequestId,
          ticketKey: input.ticketKey,
          outDir: input.outDir,
          configPath: input.configPath,
          maxSourceFiles: input.maxSourceFiles,
          maxSourceFileChars: input.maxSourceFileChars,
          noComment: input.noComment,
        }),
        output: (output) => output ?? { status: "skipped" },
      },
    );
    await tracedReview(args);
  } finally {
    await flushPhoenixTelemetry();
  }
}

export async function runPullRequestCodeReview(
  args: ParsedArgs,
  logProgress = createProgressLogger("review-pull-request"),
): Promise<{ jsonPath: string; markdownPath: string } | undefined> {
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

  if (!config.jiraRest) {
    throw new CliError("Missing Jira REST config. Set JIRA_URL, JIRA_USERNAME, and JIRA_API_TOKEN.");
  }

  const pullRequestRef = resolvePullRequestRef(args);
  const azureClient = new AzureDevOpsClient({ token: config.azureDevOps.token });
  const pullRequestSource = new AzureDevOpsPullRequestReviewSource(azureClient);
  logProgress(`Loading Azure DevOps pull request ${pullRequestRef.pullRequestId}.`);
  const pullRequest = await pullRequestSource.getPullRequest(pullRequestRef);

  const detectedTicketKey =
    args.ticketKey ??
    detectJiraIssueKey([
      pullRequest.sourceBranch,
      pullRequest.title,
      pullRequest.description,
    ]);

  if (!detectedTicketKey) {
    logProgress("No Jira ticket key was found in source branch, pull request title, or pull request description. Skipping automated review.");
    return undefined;
  }

  logProgress(`Detected Jira ticket ${detectedTicketKey}.`);
  const atlassianClient = new AtlassianRestClient({
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
  const ticketSource = new AtlassianRestSource({
    client: atlassianClient,
    ...(config.jiraRest.jiraCloudId ? { jiraCloudId: config.jiraRest.jiraCloudId } : {}),
  });

  try {
    logProgress(`Extracting Jira context for ${detectedTicketKey}.`);
    const ticket = await extractTicketContext(detectedTicketKey, ticketSource);

    logProgress("Fetching pull request diff.");
    const diffOptions: { maxChangedSourceFiles?: number; maxSourceFileChars?: number } = {};
    if (args.maxSourceFiles !== undefined) {
      diffOptions.maxChangedSourceFiles = args.maxSourceFiles;
    }
    if (args.maxSourceFileChars !== undefined) {
      diffOptions.maxSourceFileChars = args.maxSourceFileChars;
    }
    const diffSource = new AzureDevOpsPullRequestDiffSource(azureClient, diffOptions);
    const diff = await diffSource.getPullRequestDiff(pullRequestToContextPullRequest(pullRequest));

    const llmClient = createLlmTextClient(config.llm, { phoenixTelemetry: config.observability?.phoenix });
    logProgress(`Reviewing pull request with ${llmClient.provider} model ${llmClient.model}.`);
    const reviewer = new LlmPullRequestCodeReviewer({ client: llmClient });
    const warnings: Warning[] = [...ticket.warnings, ...pullRequestSource.getWarnings(), ...diffSource.getWarnings()];
    const pack = await extractCodeReview(pullRequest, ticket, diff, reviewer, {
      detectedTicketKey,
      warnings,
      tools: [
        ...ticketSource.getProvenance(),
        ...pullRequestSource.getProvenance(),
        ...diffSource.getProvenance(),
      ],
    });

    logProgress(`Writing code review output to ${args.outDir}.`);
    const result = await writeCodeReviewPack(pack, args.outDir);
    console.log(`Wrote ${result.jsonPath}`);
    console.log(`Wrote ${result.markdownPath}`);

    if (!args.noComment) {
      logProgress("Posting code review comment to pull request.");
      const sink = new AzureDevOpsPullRequestCommentSink(azureClient);
      await sink.createThread(pullRequestRef, renderCodeReviewComment(pack));
      console.log(`Posted code review comment to ${pullRequest.url}`);
    } else {
      logProgress("Skipping pull request comment because --no-comment was provided.");
    }

    return { jsonPath: result.jsonPath, markdownPath: result.markdownPath };
  } finally {
    await ticketSource.close();
  }
}

export interface ParsedArgs {
  organization?: string;
  project?: string;
  repository?: string;
  pullRequestId?: number;
  ticketKey?: string;
  outDir: string;
  configPath?: string;
  maxSourceFiles?: number;
  maxSourceFileChars?: number;
  noComment: boolean;
  help: boolean;
}

function parseCliArgs(argv = process.argv.slice(2)): ParsedArgs {
  const parsed = parseArgs({
    args: argv,
    options: {
      organization: { type: "string" },
      project: { type: "string" },
      repository: { type: "string" },
      "pull-request-id": { type: "string" },
      ticket: { type: "string" },
      out: { type: "string" },
      config: { type: "string" },
      "max-source-files": { type: "string" },
      "max-source-file-chars": { type: "string" },
      "no-comment": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  const pullRequestIdValue = asString(parsed.values["pull-request-id"]);
  const organization = asString(parsed.values.organization);
  const project = asString(parsed.values.project);
  const repository = asString(parsed.values.repository);
  const ticket = asString(parsed.values.ticket);
  const config = asString(parsed.values.config);
  const maxSourceFiles = asString(parsed.values["max-source-files"]);
  const maxSourceFileChars = asString(parsed.values["max-source-file-chars"]);

  return {
    ...(organization ? { organization } : {}),
    ...(project ? { project } : {}),
    ...(repository ? { repository } : {}),
    ...(pullRequestIdValue ? { pullRequestId: parsePositiveInteger(pullRequestIdValue, "--pull-request-id") } : {}),
    ...(ticket ? { ticketKey: ticket.toUpperCase() } : {}),
    outDir: asString(parsed.values.out) ?? "./out",
    ...(config ? { configPath: config } : {}),
    ...(maxSourceFiles ? { maxSourceFiles: parseNonNegativeInteger(maxSourceFiles, "--max-source-files", 10) } : {}),
    ...(maxSourceFileChars ? { maxSourceFileChars: parseNonNegativeInteger(maxSourceFileChars, "--max-source-file-chars", 50_000) } : {}),
    noComment: asBoolean(parsed.values["no-comment"]),
    help: asBoolean(parsed.values.help),
  };
}

function resolvePullRequestRef(args: ParsedArgs): AzureDevOpsPullRequestRef {
  if (args.organization && args.project && args.repository && args.pullRequestId) {
    return {
      repository: {
        organization: args.organization,
        project: args.project,
        repository: args.repository,
      },
      pullRequestId: args.pullRequestId,
    };
  }

  const fromEnvironment = resolveAzureDevOpsPullRequestRefFromEnvironment();
  if (fromEnvironment) {
    return fromEnvironment;
  }

  throw new CliError(
    "Could not resolve pull request. Run in an Azure DevOps pull request pipeline or pass --organization, --project, --repository, and --pull-request-id.",
  );
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError(`${optionName} must be a positive integer. Actual value: ${value}`);
  }

  return parsed;
}

function printHelp(): void {
  console.log(`Pull Request Code Reviewer

Usage:
  review-pull-request
  review-pull-request --organization my-org --project my-project --repository my-repo --pull-request-id 123

Options:
  --organization <name>          Azure DevOps organization. Defaults to pipeline env.
  --project <name>               Azure DevOps project. Defaults to pipeline env.
  --repository <name-or-id>      Azure DevOps repository. Defaults to pipeline env.
  --pull-request-id <id>         Azure DevOps pull request id. Defaults to pipeline env.
  --ticket <key>                 Jira ticket key override. Otherwise detected from branch/title/description.
  --out <dir>                    Output root directory. Defaults to ./out.
  --config <path>                Optional JSON config for non-secret overrides.
  --max-source-files <number>    Changed source files to fetch. Defaults to 10.
  --max-source-file-chars <n>    Max characters per source file. Defaults to 50000.
  --no-comment                   Write artifacts only; do not post to the PR.
  -h, --help                     Show this help.
`);
}

if (isCliEntrypoint(import.meta.url)) {
  main().catch(handleCliError);
}
