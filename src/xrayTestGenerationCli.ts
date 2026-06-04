#!/usr/bin/env node
import "dotenv/config";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import { ConfluenceImpactPackSchema } from "./domain/confluenceImpact/schema.js";
import { ContextPackSchema } from "./domain/contextPack/schema.js";
import type { Warning } from "./domain/contextPack/schema.js";
import { PrChangesPackSchema } from "./domain/prChanges/schema.js";
import { XrayTestReviewPackSchema } from "./domain/xrayTestReview/schema.js";
import type { ConfluenceImpactPack } from "./domain/confluenceImpact/schema.js";
import type { PrChangesPack } from "./domain/prChanges/schema.js";
import type { XrayTestReviewPack } from "./domain/xrayTestReview/schema.js";
import { AtlassianRestClient } from "./integrations/atlassianRest/client.js";
import { createLlmTextClient } from "./integrations/llm/factory.js";
import { LlmXrayTestPlanner } from "./integrations/llm/adapters/xrayTestPlanner.js";
import {
  createTracedWorkflow,
  flushTelemetry,
  jiraIssueSessionId,
  setActiveSpanAttributes,
} from "./integrations/llm/telemetry/observability.js";
import { XrayCloudClient } from "./integrations/xray/client.js";
import { XrayCloudTestSink } from "./integrations/xray/testSink.js";
import { writeXrayTestGenerationPack } from "./output/xray-test-generation/writer.js";
import { CliError, handleCliError, isCliEntrypoint } from "./shared/cli.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import { runContextExtractor } from "./contextExtractorCli.js";
import { extractXrayTestGeneration } from "./workflows/xray-test-generation/extractor.js";

async function main(): Promise<void> {
  const args = parseCliArgs();
  const logProgress = createProgressLogger("generate-xray-tests");

  if (args.help) {
    printHelp();
    return;
  }

  await runGenerateXrayTests(args, logProgress);
}

export async function runGenerateXrayTests(
  args: ParsedArgs,
  logProgress = createProgressLogger("generate-xray-tests"),
): Promise<XrayTestGenerationCliResult> {
  const config = await loadRuntimeConfig({
    ...(args.configPath ? { configPath: args.configPath } : {}),
  });
  const tracedWorkflow = createTracedWorkflow(
    (input: ParsedArgs) => runGenerateXrayTestsUntraced(input, logProgress, config),
    config.observability?.telemetry,
    {
      name: "workflow.generate-xray-tests",
      attributes: {
        "workflow.name": "generate-xray-tests",
        ...(args.issue ? { "workflow.issue": args.issue } : {}),
        "workflow.dry_run": args.dryRun,
      },
      sessionId: (input) => jiraIssueSessionId(input.issue),
      input: (input) => ({
        issue: input.issue,
        contextPath: input.contextPath,
        outDir: input.outDir,
        dryRun: input.dryRun,
        configPath: input.configPath,
      }),
      output: (output) => output,
    },
  );

  return tracedWorkflow(args);
}

async function runGenerateXrayTestsUntraced(
  args: ParsedArgs,
  logProgress: (message: string) => void,
  config: Awaited<ReturnType<typeof loadRuntimeConfig>>,
): Promise<XrayTestGenerationCliResult> {
  const contextExtraction = await runTracedContextExtraction(args, config, logProgress);
  const result = await runXrayTestGenerationFromContext(
    {
      ...args,
      contextPath: contextExtraction.contextPath,
    },
    logProgress,
    config,
  );

  return {
    contextPath: contextExtraction.contextPath,
    jsonPath: result.jsonPath,
    markdownPath: result.markdownPath,
  };
}

async function runTracedContextExtraction(
  args: ParsedArgs,
  config: Awaited<ReturnType<typeof loadRuntimeConfig>>,
  logProgress: (message: string) => void,
): Promise<{ contextPath: string }> {
  const tracedContextExtractor = createTracedWorkflow(
    (input: ParsedArgs) => runContextExtractor({
      ...(input.issue ? { issue: input.issue } : {}),
      outDir: input.outDir,
      ...(input.contextPath ? { contextPath: input.contextPath } : {}),
      ...(input.configPath ? { configPath: input.configPath } : {}),
      help: false,
    }, logProgress),
    config.observability?.telemetry,
    {
      name: "task.context-extractor",
      attributes: {
        "workflow.name": "context-extractor",
        ...(args.issue ? { "workflow.issue": args.issue } : {}),
      },
      sessionId: (input) => jiraIssueSessionId(input.issue),
      input: (input) => ({
        issue: input.issue,
        contextPath: input.contextPath,
        outDir: input.outDir,
        configPath: input.configPath,
      }),
      output: (output) => output,
    },
  );

  return tracedContextExtractor(args);
}

export async function runXrayTestGenerationFromContext(
  args: ParsedArgs,
  logProgress = createProgressLogger("generate-xray-tests"),
  loadedConfig?: Awaited<ReturnType<typeof loadRuntimeConfig>>,
): Promise<{ jsonPath: string; markdownPath: string }> {
  const contextPath = resolveContextPath(args);
  const outputDir = dirname(contextPath);
  logProgress(`Loading context from ${contextPath}.`);
  const context = ContextPackSchema.parse(JSON.parse(await readFile(contextPath, "utf8")));
  setActiveSpanAttributes({ "workflow.issue": context.ticket.key });
  logProgress(
    `Loaded context for ${context.ticket.key}: ${context.xrayTestCases.length} existing Xray test(s), ${context.comments.length} comment(s), ${context.confluencePages.length} linked Confluence page(s).`,
  );

  const warnings: Warning[] = [];
  const xrayTestReviewPath = resolveXrayTestReviewPath(args, outputDir);
  const prChangesPath = resolvePrChangesPath(args, outputDir);
  const confluenceImpactPath = resolveConfluenceImpactPath(args, outputDir);
  const xrayTestReview = await readOptionalXrayTestReview(
    xrayTestReviewPath,
    Boolean(args.xrayTestReviewPath),
    context.xrayTestCases.length > 0,
    warnings,
    logProgress,
  );
  const prChanges = await readOptionalPrChanges(prChangesPath, Boolean(args.prChangesPath), warnings, logProgress);
  const confluenceImpact = await readOptionalConfluenceImpact(
    confluenceImpactPath,
    Boolean(args.confluenceImpactPath),
    warnings,
    logProgress,
  );

  logProgress("Loading runtime configuration.");
  const config = loadedConfig ?? await loadRuntimeConfig({
    ...(args.configPath ? { configPath: args.configPath } : {}),
  });

  if (!config.llm) {
    throw new CliError("Missing LLM config. Set LLM_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.");
  }

  if (!args.dryRun && !config.jiraRest) {
    throw new CliError("Missing Jira REST config. Set JIRA_URL, JIRA_USERNAME, and JIRA_API_TOKEN.");
  }

  if (!args.dryRun && !config.xray) {
    throw new CliError("Missing Xray Cloud config. Set XRAY_CLIENT_ID and XRAY_CLIENT_SECRET.");
  }

  const llmClient = createLlmTextClient(config.llm, { telemetry: config.observability?.telemetry });
  logProgress(`Using ${llmClient.provider} model ${llmClient.model}.`);
  if (args.dryRun) {
    logProgress("Dry run mode is enabled; Jira and Xray writes will be skipped.");
  } else {
    logProgress(`Xray/Jira mutation mode is enabled. Xray base URL: ${config.xray?.baseUrl}.`);
  }

  const planner = new LlmXrayTestPlanner({ client: llmClient });
  const sink =
    args.dryRun || !config.jiraRest || !config.xray
      ? undefined
      : new XrayCloudTestSink({
          jira: new AtlassianRestClient({
            jira: {
              baseUrl: config.jiraRest.jiraUrl,
              username: config.jiraRest.jiraUsername,
              apiToken: config.jiraRest.jiraApiToken,
            },
          }),
          xray: new XrayCloudClient({
            baseUrl: config.xray.baseUrl,
            clientId: config.xray.clientId,
            clientSecret: config.xray.clientSecret,
          }),
          issueLinkTypeNameHint: config.xray.testIssueLinkType,
          issueLinkDirection: config.xray.testIssueLinkDirection,
          onProgress: logProgress,
        });
  logProgress("Starting Xray test generation workflow.");
  const pack = await extractXrayTestGeneration(context, xrayTestReview, prChanges, confluenceImpact, planner, sink, {
    sourceContextPath: contextPath,
    ...(xrayTestReview ? { sourceXrayTestReviewPath: xrayTestReviewPath } : {}),
    ...(prChanges ? { sourcePrChangesPath: prChangesPath } : {}),
    ...(confluenceImpact ? { sourceConfluenceImpactPath: confluenceImpactPath } : {}),
    dryRun: args.dryRun,
    warnings,
    onProgress: logProgress,
  });
  logProgress(`Writing Xray test generation outputs to ${outputDir}.`);
  const result = await writeXrayTestGenerationPack(pack, outputDir);

  console.log(`Wrote ${result.jsonPath}`);
  console.log(`Wrote ${result.markdownPath}`);
  if (args.dryRun) {
    console.warn("Dry run completed. No Xray or Jira mutations were performed.");
  }
  if (pack.warnings.length > 0) {
    console.warn(`Completed with ${pack.warnings.length} warning(s). See xray-test-generation.json/xray-test-generation.md.`);
  }

  return result;
}

export interface ParsedArgs {
  issue?: string;
  outDir: string;
  contextPath?: string;
  xrayTestReviewPath?: string;
  prChangesPath?: string;
  confluenceImpactPath?: string;
  configPath?: string;
  dryRun: boolean;
  help: boolean;
}

export interface XrayTestGenerationCliResult {
  contextPath: string;
  jsonPath: string;
  markdownPath: string;
}

function parseCliArgs(): ParsedArgs {
  const parsed = parseArgs({
    options: {
      issue: { type: "string" },
      out: { type: "string" },
      context: { type: "string" },
      "xray-test-review": { type: "string" },
      "pr-changes": { type: "string" },
      "confluence-impact": { type: "string" },
      config: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  return {
    ...(parsed.values.issue ? { issue: parsed.values.issue } : {}),
    outDir: parsed.values.out ?? "./out",
    ...(parsed.values.context ? { contextPath: parsed.values.context } : {}),
    ...(parsed.values["xray-test-review"] ? { xrayTestReviewPath: parsed.values["xray-test-review"] } : {}),
    ...(parsed.values["pr-changes"] ? { prChangesPath: parsed.values["pr-changes"] } : {}),
    ...(parsed.values["confluence-impact"] ? { confluenceImpactPath: parsed.values["confluence-impact"] } : {}),
    ...(parsed.values.config ? { configPath: parsed.values.config } : {}),
    dryRun: parsed.values["dry-run"] ?? false,
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

function resolveXrayTestReviewPath(args: ParsedArgs, outputDir: string): string {
  return args.xrayTestReviewPath ?? join(outputDir, "xray-test-review.json");
}

function resolvePrChangesPath(args: ParsedArgs, outputDir: string): string {
  return args.prChangesPath ?? join(outputDir, "pr-changes.json");
}

function resolveConfluenceImpactPath(args: ParsedArgs, outputDir: string): string {
  return args.confluenceImpactPath ?? join(outputDir, "confluence-impact.json");
}

async function readOptionalXrayTestReview(
  path: string,
  explicit: boolean,
  warnIfMissing: boolean,
  warnings: Warning[],
  logProgress?: (message: string) => void,
): Promise<XrayTestReviewPack | undefined> {
  logProgress?.(`Looking for optional Xray test review pack at ${path}.`);
  if (!(await exists(path))) {
    if (explicit) {
      throw new CliError(`Explicit --xray-test-review path was not found: ${path}`);
    }

    if (warnIfMissing) {
      warnings.push({
        section: "xrayTestReview",
        toolName: "file:read",
        message: `Optional Xray test review pack not found at ${path}; generating tests without reviewed existing-test coverage.`,
      });
      logProgress?.("Optional Xray test review pack was not found; continuing without reviewed existing-test coverage.");
    } else {
      logProgress?.("No linked Xray tests are present; continuing without an Xray test review pack.");
    }
    return undefined;
  }

  const pack = XrayTestReviewPackSchema.parse(JSON.parse(await readFile(path, "utf8")));
  logProgress?.(`Loaded Xray test review pack with ${pack.review.testCases.length} reviewed test case(s).`);
  return pack;
}

async function readOptionalPrChanges(
  path: string,
  explicit: boolean,
  warnings: Warning[],
  logProgress?: (message: string) => void,
): Promise<PrChangesPack | undefined> {
  logProgress?.(`Looking for optional PR changes pack at ${path}.`);
  if (!(await exists(path))) {
    if (explicit) {
      throw new CliError(`Explicit --pr-changes path was not found: ${path}`);
    }

    warnings.push({
      section: "prChanges",
      toolName: "file:read",
      message: `Optional PR changes pack not found at ${path}; generating tests without PR change summaries.`,
    });
    logProgress?.("Optional PR changes pack was not found; continuing without PR change summaries.");
    return undefined;
  }

  const pack = PrChangesPackSchema.parse(JSON.parse(await readFile(path, "utf8")));
  logProgress?.(`Loaded PR changes pack with ${pack.pullRequests.length} pull request(s).`);
  return pack;
}

async function readOptionalConfluenceImpact(
  path: string,
  explicit: boolean,
  warnings: Warning[],
  logProgress?: (message: string) => void,
): Promise<ConfluenceImpactPack | undefined> {
  logProgress?.(`Looking for optional Confluence impact pack at ${path}.`);
  if (!(await exists(path))) {
    if (explicit) {
      throw new CliError(`Explicit --confluence-impact path was not found: ${path}`);
    }

    warnings.push({
      section: "confluenceImpact",
      toolName: "file:read",
      message: `Optional Confluence impact pack not found at ${path}; generating tests without Confluence impact summaries.`,
    });
    logProgress?.("Optional Confluence impact pack was not found; continuing without Confluence impact summaries.");
    return undefined;
  }

  const pack = ConfluenceImpactPackSchema.parse(JSON.parse(await readFile(path, "utf8")));
  logProgress?.(`Loaded Confluence impact pack with ${pack.pages.length} page(s).`);
  return pack;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function printHelp(): void {
  console.log(`Xray Test Generator

Usage:
  generate-xray-tests --issue ABC-123 --out ./out
  generate-xray-tests --context ./out/ABC-123/context.json
  generate-xray-tests --issue ABC-123 --out ./out --dry-run

Options:
  --issue <key>                  Jira issue key to extract, enrich, design, and upload tests for.
  --out <dir>                    Output root directory. Defaults to ./out.
  --context <path>               Optional existing context.json path to reuse as extraction input.
  --xray-test-review <path>      Optional explicit existing-xray-test review pack.
  --pr-changes <path>            Optional explicit PR changes pack.
  --confluence-impact <path>     Optional explicit Confluence impact pack.
  --config <path>                Optional JSON config for non-secret overrides.
  --dry-run                      Generate files without Jira/Xray mutations or Xray uploads.
  -h, --help                     Show this help.
`);
}

if (isCliEntrypoint(import.meta.url)) {
  main().finally(flushTelemetry).catch(handleCliError);
}
