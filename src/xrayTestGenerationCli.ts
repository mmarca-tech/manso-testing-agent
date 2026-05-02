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
import { OpenAiXrayTestPlanner } from "./integrations/openai/xrayTestPlanner.js";
import { XrayCloudClient } from "./integrations/xray/client.js";
import { XrayCloudTestSink } from "./integrations/xray/testSink.js";
import { writeXrayTestGenerationPack } from "./output/xray-test-generation/writer.js";
import { createProgressLogger } from "./shared/cliLogger.js";
import { extractXrayTestGeneration } from "./workflows/xray-test-generation/extractor.js";

async function main(): Promise<void> {
  const args = parseCliArgs();
  const logProgress = createProgressLogger("generate-xray-tests");

  if (args.help) {
    printHelp();
    return;
  }

  const contextPath = resolveContextPath(args);
  const outputDir = dirname(contextPath);
  logProgress(`Loading context from ${contextPath}.`);
  const context = ContextPackSchema.parse(JSON.parse(await readFile(contextPath, "utf8")));
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
  const config = await loadRuntimeConfig({
    ...(args.configPath ? { configPath: args.configPath } : {}),
  });

  if (!config.openAi) {
    throw new CliError("Missing OpenAI config. Set OPENAI_API_KEY, and optionally OPENAI_MODEL.");
  }

  if (!args.dryRun && !config.jiraRest) {
    throw new CliError("Missing Jira REST config. Set JIRA_URL, JIRA_USERNAME, and JIRA_API_TOKEN.");
  }

  if (!args.dryRun && !config.xray) {
    throw new CliError("Missing Xray Cloud config. Set XRAY_CLIENT_ID and XRAY_CLIENT_SECRET.");
  }

  logProgress(`Using OpenAI model ${config.openAi.model}.`);
  if (args.dryRun) {
    logProgress("Dry run mode is enabled; Jira and Xray writes will be skipped.");
  } else {
    logProgress(`Xray/Jira mutation mode is enabled. Xray base URL: ${config.xray?.baseUrl}.`);
  }

  const planner = new OpenAiXrayTestPlanner({
    apiKey: config.openAi.apiKey,
    model: config.openAi.model,
    ...(config.openAi.baseUrl ? { baseUrl: config.openAi.baseUrl } : {}),
  });
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
}

interface ParsedArgs {
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
  --issue <key>                  Jira issue key whose ./out/<key>/context.json should be used.
  --out <dir>                    Output root directory. Defaults to ./out.
  --context <path>               Explicit context.json path.
  --xray-test-review <path>      Optional explicit xray-test-review.json path.
  --pr-changes <path>            Optional explicit pr-changes.json path.
  --confluence-impact <path>     Optional explicit confluence-impact.json path.
  --config <path>                Optional JSON config for non-secret overrides.
  --dry-run                      Generate files without Jira/Xray mutations.
  -h, --help                     Show this help.
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
