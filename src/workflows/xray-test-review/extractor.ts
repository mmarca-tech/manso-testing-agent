import type { ContextPack, ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import {
  XRAY_TEST_REVIEW_SCHEMA_VERSION,
  XrayTestReviewAnalysisSchema,
  XrayTestReviewPackSchema,
} from "../../domain/xrayTestReview/schema.js";
import type { XrayTestReviewAnalysis, XrayTestReviewPack } from "../../domain/xrayTestReview/schema.js";
import type { XrayTestReviewer } from "./reviewer.js";
import type { XrayTestDefinition, XrayTestDefinitionSource } from "./xrayTestDefinitionSource.js";

export interface ExtractXrayTestReviewOptions {
  sourceContextPath: string;
  testDefinitions?: XrayTestDefinition[];
  definitionSource?: XrayTestDefinitionSource;
  definitionProvenance?: ToolProvenance[];
  definitionWarnings?: Warning[];
  warnings?: Warning[];
  onProgress?: (message: string) => void;
}

export async function extractXrayTestReview(
  context: ContextPack,
  reviewer: XrayTestReviewer | undefined,
  options: ExtractXrayTestReviewOptions,
): Promise<XrayTestReviewPack> {
  const warnings = [...(options.warnings ?? [])];
  const testDefinitions =
    context.xrayTestCases.length === 0
      ? []
      : options.testDefinitions ?? await fetchTestDefinitions(context, options.definitionSource, warnings, options.onProgress);
  const review =
    context.xrayTestCases.length === 0
      ? emptyReview()
      : await reviewLinkedTests(context, testDefinitions, reviewer, options.onProgress);

  const pack: XrayTestReviewPack = {
    schemaVersion: XRAY_TEST_REVIEW_SCHEMA_VERSION,
    ticket: {
      key: context.ticket.key,
      title: context.ticket.title,
      ...(context.ticket.url ? { url: context.ticket.url } : {}),
    },
    review,
    provenance: {
      generatedAt: new Date().toISOString(),
      sourceContextPath: options.sourceContextPath,
      ...(context.xrayTestCases.length > 0 && reviewer
        ? {
            llm: {
              provider: reviewer.provider,
              model: reviewer.model,
            },
          }
        : {}),
      tools: [
        ...(options.definitionProvenance ?? options.definitionSource?.getProvenance() ?? []),
        ...(reviewer?.getProvenance() ?? []),
      ],
    },
    warnings: [
      ...warnings,
      ...(options.definitionWarnings ?? options.definitionSource?.getWarnings() ?? []),
      ...(reviewer?.getWarnings() ?? []),
    ],
  };

  return XrayTestReviewPackSchema.parse(pack);
}

async function reviewLinkedTests(
  context: ContextPack,
  testDefinitions: XrayTestDefinition[],
  reviewer: XrayTestReviewer | undefined,
  onProgress: ((message: string) => void) | undefined,
): Promise<XrayTestReviewAnalysis> {
  if (!reviewer) {
    throw new Error("Xray test reviewer is required when linked Xray tests are present.");
  }

  onProgress?.(`Requesting linked Xray test review from ${reviewer.provider}/${reviewer.model}.`);
  const review = await reviewer.review({ context, testDefinitions });
  onProgress?.(`Received linked Xray test review for ${review.testCases.length} test case(s).`);
  return XrayTestReviewAnalysisSchema.parse(review);
}

async function fetchTestDefinitions(
  context: ContextPack,
  definitionSource: XrayTestDefinitionSource | undefined,
  warnings: Warning[],
  onProgress: ((message: string) => void) | undefined,
): Promise<XrayTestDefinition[]> {
  if (!definitionSource) {
    warnings.push({
      section: "xrayTestDefinitions",
      toolName: "xray:getExpandedTests",
      message: "Xray Cloud config was not available; linked test review used context.json test metadata only.",
    });
    onProgress?.("Xray Cloud definition source is unavailable; linked test review will use context metadata only.");
    return [];
  }

  try {
    onProgress?.(`Fetching Xray definitions for ${context.xrayTestCases.length} linked test case(s).`);
    const definitions = await definitionSource.getTestDefinitions(context.xrayTestCases);
    onProgress?.(`Fetched ${definitions.length} Xray test definition(s).`);
    return definitions;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push({
      section: "xrayTestDefinitions",
      toolName: "xray:getExpandedTests",
      message: `Could not fetch Xray test definitions; linked test review used context.json test metadata only. ${message}`,
    });
    onProgress?.(`Could not fetch Xray test definitions; continuing with context metadata only. ${message}`);
    return [];
  }
}

function emptyReview(): XrayTestReviewAnalysis {
  return {
    overallSummary: "No linked Xray test cases were present in the source context.",
    coveredAcceptanceCriteria: [],
    gapsOrAmbiguities: ["No existing linked Xray tests were available to review."],
    testCases: [],
  };
}
