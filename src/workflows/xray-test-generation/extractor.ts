import type { Warning } from "../../domain/contextPack/schema.js";
import type { ContextPack } from "../../domain/contextPack/schema.js";
import type { ConfluenceImpactPack } from "../../domain/confluenceImpact/schema.js";
import type { PrChangesPack } from "../../domain/prChanges/schema.js";
import type { XrayTestReviewPack } from "../../domain/xrayTestReview/schema.js";
import {
  XRAY_TEST_GENERATION_SCHEMA_VERSION,
  XrayTestGenerationPackSchema,
} from "../../domain/xrayTestGeneration/schema.js";
import type {
  AppliedXrayTestCase,
  XrayTestApplication,
  XrayTestGenerationPack,
  XrayTestGenerationPlan,
} from "../../domain/xrayTestGeneration/schema.js";
import type { XrayTestPlanner } from "./testPlanner.js";
import type { XrayTestSink } from "./xrayTestSink.js";
import { assertXrayPlanReadyForApplication } from "./qualityGate.js";

export interface ExtractXrayTestGenerationOptions {
  sourceContextPath: string;
  sourceXrayTestReviewPath?: string;
  sourcePrChangesPath?: string;
  sourceConfluenceImpactPath?: string;
  dryRun: boolean;
  warnings?: Warning[];
  onProgress?: (message: string) => void;
}

export async function extractXrayTestGeneration(
  context: ContextPack,
  xrayTestReview: XrayTestReviewPack | undefined,
  prChanges: PrChangesPack | undefined,
  confluenceImpact: ConfluenceImpactPack | undefined,
  planner: XrayTestPlanner,
  sink: XrayTestSink | undefined,
  options: ExtractXrayTestGenerationOptions,
): Promise<XrayTestGenerationPack> {
  options.onProgress?.(`Requesting Xray test plan from ${planner.provider}/${planner.model}.`);
  const plan = await planner.plan({
    context,
    ...(xrayTestReview ? { xrayTestReview } : {}),
    ...(prChanges ? { prChanges } : {}),
    ...(confluenceImpact ? { confluenceImpact } : {}),
  });
  options.onProgress?.(`Received Xray test plan with ${plan.testCases.length} test case(s) and ${plan.coverageGaps.length} coverage gap(s).`);
  options.onProgress?.("Running deterministic Xray plan quality gate.");
  assertXrayPlanReadyForApplication(plan);

  if (options.dryRun) {
    options.onProgress?.("Dry run enabled; skipping Jira and Xray mutations.");
  } else {
    options.onProgress?.("Applying generated test plan to Jira/Xray.");
  }

  const application = options.dryRun ? dryRunApplication(context.ticket.key, context.ticket.title, plan) : await applyPlan(context, plan, sink);
  options.onProgress?.(`Application phase complete with status ${application.status}. Validating output pack.`);

  const pack: XrayTestGenerationPack = {
    schemaVersion: XRAY_TEST_GENERATION_SCHEMA_VERSION,
    ticket: {
      key: context.ticket.key,
      title: context.ticket.title,
      ...(context.ticket.url ? { url: context.ticket.url } : {}),
    },
    plan,
    application,
    provenance: {
      generatedAt: new Date().toISOString(),
      sourceContextPath: options.sourceContextPath,
      ...(options.sourceXrayTestReviewPath ? { sourceXrayTestReviewPath: options.sourceXrayTestReviewPath } : {}),
      ...(options.sourcePrChangesPath ? { sourcePrChangesPath: options.sourcePrChangesPath } : {}),
      ...(options.sourceConfluenceImpactPath ? { sourceConfluenceImpactPath: options.sourceConfluenceImpactPath } : {}),
      llm: {
        provider: planner.provider,
        model: planner.model,
      },
      tools: [...planner.getProvenance(), ...(sink?.getProvenance() ?? [])],
    },
    warnings: [...(options.warnings ?? []), ...planner.getWarnings(), ...(sink?.getWarnings() ?? [])],
  };

  return XrayTestGenerationPackSchema.parse(pack);
}

async function applyPlan(
  context: ContextPack,
  plan: XrayTestGenerationPlan,
  sink: XrayTestSink | undefined,
): Promise<XrayTestApplication> {
  if (!sink) {
    throw new Error("Xray test sink is required when dryRun is false.");
  }

  return sink.apply({
    ticketKey: context.ticket.key,
    ticketTitle: context.ticket.title,
    projectKey: projectKeyFromIssueKey(context.ticket.key),
    plan,
  });
}

function dryRunApplication(ticketKey: string, ticketTitle: string, plan: XrayTestGenerationPlan): XrayTestApplication {
  const tests: AppliedXrayTestCase[] = plan.testCases.map((testCase) => ({
    action: testCase.action,
    status: "skipped",
    requestedTitle: testCase.title,
    ...(testCase.existingTestKey ? { existingTestKey: testCase.existingTestKey } : {}),
    warnings: ["Dry run enabled; no Xray or Jira mutations were performed."],
  }));

  return {
    status: "dry-run",
    tests,
    testSet: {
      status: "dry-run",
      title: `${ticketKey} Generated Test Set - ${ticketTitle}`,
      includedTestKeys: plan.testCases.map((testCase) => testCase.existingTestKey).filter((key): key is string => Boolean(key)),
      includedTestIssueIds: [],
      warnings: ["Dry run enabled; test set was not created."],
    },
  };
}

function projectKeyFromIssueKey(issueKey: string): string {
  const [projectKey] = issueKey.split("-");
  if (!projectKey) {
    throw new Error(`Could not derive project key from Jira issue key ${issueKey}.`);
  }

  return projectKey;
}
