import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { isCabinActive, registerCabinArtifacts } from "../memory/cabin.js";
import { runResearcher } from "../agents/researcher/index.js";
import { runCoverageGapAnalyser, formatAnalysisAsComment } from "../agents/coverageGapAnalyser/index.js";
import { extractAcceptanceCriteria } from "../agents/testArchitect/acExtraction.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../config/runtimeConfig.js";
import { loadAgentConfig } from "../config/agentConfig.js";
import { auditLogPath, emitAudit } from "../policy/auditLog.js";
import type { ContextProvider } from "../context/providerRegistry.js";
import { createJiraRestProviderFromRuntime } from "../context/providers/jiraRestProvider.js";
import type { ContextPack } from "../domain/contextPack/schema.js";
import { AtlassianRestClient } from "../integrations/atlassianRest/client.js";
import { XrayCloudClient } from "../integrations/xray/client.js";
import { fetchLinkedCucumberTests, type LinkedCucumberTest } from "../integrations/xray/testFetch.js";
import { extractStepLibrary } from "../context/stepLibrary.js";
import { createLlmTextClient } from "../integrations/llm/factory.js";
import { jiraIssueSessionId, withTelemetrySession } from "../integrations/llm/telemetry/observability.js";
import type { LlmTextClient } from "../integrations/llm/types.js";
import { applyTestDesignToXray } from "../integrations/xray/testDesignSink.js";
import { loadSkills } from "../skillLoader/loader.js";
import { writeContextPack } from "../output/context-pack/writer.js";
import { CliError, mergeTestFields, parseJsonObjectArg } from "../shared/cli.js";
import type { CommandModule } from "./main.js";
import {
  TEST_DESIGN_SCHEMA_VERSION,
  TestDesignPackSchema,
  type TestDesignPack,
  type TestScenario,
  type RiskRankingEntry,
  type RiskLevel,
} from "../domain/testDesignPack/schema.js";

const HELP = `manso analyse-coverage - analyse test coverage gaps for a user story.

Usage:
  manso analyse-coverage --issue <KEY> [options]

Options:
  --issue <KEY>     Jira issue key (e.g. ABC-123). Required.
  --out <dir>       Output root directory. Defaults to ./out.
  --repo <path>     Optional target repo: its .feature step vocabulary and
                    .agents/skills override are reused when generating new tests.
  --config <path>   Optional JSON runtime-config file for non-secret overrides.
  --comment         Post the coverage analysis as a Jira comment on the story.
  --create-tests    Create the missing test cases in Xray and link to the story.
  --dry-run         Skip Xray/Jira mutations; record what would have happened.
  --test-fields <json>  Extra Jira fields for created Test issues, as a JSON
                    object (e.g. '{"customfield_15714":170}'). Merged over the
                    repo's xray.testFields (flag wins).
  --reporter <accountId>  Jira account id to set as Reporter on created Test
                    issues (needs the project's "Modify Reporter" permission).
  --yes             Confirm Xray uploads (required when --create-tests is used).
  -h, --help        Show this help.

This command:
  1. Fetches the user story context (description, ACs, comments, attachments).
  2. Fetches all linked Cucumber test cases including their Gherkin bodies.
  3. Uses an LLM (as a senior QA engineer) to assess coverage and identify gaps.
  4. Optionally posts the analysis as a Jira comment (--comment).
  5. Optionally creates missing test scenarios in Xray (--create-tests --yes).
`;

export interface AnalyseCoverageInput {
  issueKey: string;
  outDir: string;
  provider: ContextProvider;
  llm: LlmTextClient;
  jira: AtlassianRestClient;
  xray: XrayCloudClient;
  /** Post the analysis as a Jira comment. */
  postComment?: boolean;
  /** Create missing tests in Xray. */
  createTests?: boolean;
  /** Skip mutations. */
  dryRun?: boolean;
  /** Telemetry session id. */
  sessionId?: string;
  /** Xray issue-link type name for created tests (defaults to the configured "is tested by"). */
  linkTypeName?: string;
  /** Xray link direction. */
  linkDirection?: "test-to-ticket" | "ticket-to-test";
  /** Extra Jira fields for created Test issues (from `.agents` xray.testFields). */
  additionalFields?: Record<string, unknown>;
  /** gherkin-authoring skill body, injected so new scenarios follow house conventions. */
  bindingSkillBody?: string;
  /** Existing repo step phrasings, so new scenarios reuse them (from --repo). */
  existingSteps?: string[];
}

export interface AnalyseCoverageOutput {
  analysisRating: string;
  gapsFound: number;
  uncoveredCriteria: number;
  newScenariosCreated: number;
  commentPosted: boolean;
}

/**
 * Library form of `analyse-coverage`. Fetches context, linked tests, runs
 * the gap analyser, optionally posts a comment and creates missing tests.
 */
export async function runAnalyseCoverage(input: AnalyseCoverageInput): Promise<AnalyseCoverageOutput> {
  const sessionId = input.sessionId ?? jiraIssueSessionId(input.issueKey);
  return withTelemetrySession(sessionId, () => runAnalyseCoverageInner(input));
}

async function runAnalyseCoverageInner(input: AnalyseCoverageInput): Promise<AnalyseCoverageOutput> {
  // Step 1: Fetch context (same as design-tests)
  const context = await runResearcher({
    issueKey: input.issueKey,
    provider: input.provider,
    llm: input.llm,
  });

  // Step 2: Extract acceptance criteria so the analyser has structured ACs
  const skills = await loadSkills({ phase: "design" });
  const acSkill = skills.find((s) => s.name === "acceptance-criteria-extraction");
  let contextWithAcs: ContextPack = context;
  if (acSkill) {
    const acs = await extractAcceptanceCriteria({
      context,
      llm: input.llm,
      skill: acSkill,
      toolProvenance: [],
      warnings: context.warnings,
    });
    contextWithAcs = { ...context, acceptanceCriteria: acs };
  }

  // Step 3: Fetch all linked Cucumber tests with Gherkin bodies
  const fetchResult = await fetchLinkedCucumberTests({
    jira: input.jira,
    xray: input.xray,
    ticketKey: input.issueKey,
    onProgress: (msg) => console.error(msg),
  });
  const linkedTests: LinkedCucumberTest[] = fetchResult.tests;
  console.error(`Fetched ${linkedTests.length} linked Cucumber test(s) for ${input.issueKey}.`);

  // Step 4: Run the coverage gap analyser
  const { analysis, newScenarios, warnings } = await runCoverageGapAnalyser({
    context: contextWithAcs,
    linkedTests,
    llm: input.llm,
    ...(input.bindingSkillBody ? { bindingSkillBody: input.bindingSkillBody } : {}),
    ...(input.existingSteps && input.existingSteps.length > 0 ? { existingSteps: input.existingSteps } : {}),
  });

  console.error(`Coverage rating: ${analysis.rating} — ${analysis.gaps.length} gap(s), ${analysis.uncoveredCriteria.length} uncovered criterion/criteria.`);
  if (newScenarios.length > 0) {
    console.error(`Generated ${newScenarios.length} new scenario(s) to fill gaps.`);
  }

  // Step 5: Post comment if requested. Always comment the analysis (incl. an
  // "all clear" for good coverage), as a proper ADF document.
  let commentPosted = false;
  if (input.postComment) {
    const commentDoc = formatAnalysisAsComment(analysis, newScenarios);
    if (input.dryRun) {
      console.error(`Dry run: would post coverage analysis comment to ${input.issueKey} (rating: ${analysis.rating}, ${analysis.gaps.length} gap(s)).`);
    } else {
      try {
        await input.jira.postJson(
          "jira",
          `/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/comment`,
          { body: commentDoc },
        );
        commentPosted = true;
        console.error(`Posted coverage analysis comment on ${input.issueKey}.`);
      } catch (error) {
        console.error(`Failed to post comment: ${error instanceof Error ? error.message : String(error)}`);
        warnings.push({
          section: "coverageGapAnalysis",
          toolName: "jira:comment",
          message: `Failed to post comment: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  // Step 6: Create missing tests in Xray if requested
  let newScenariosCreated = 0;
  if (input.createTests && newScenarios.length > 0) {
    const projectKey = input.issueKey.includes("-") ? input.issueKey.split("-", 1)[0] ?? input.issueKey : input.issueKey;

    let testDesign: TestDesignPack | undefined;
    try {
      testDesign = buildMinimalTestDesignPack(input.issueKey, contextWithAcs, newScenarios);
    } catch (error) {
      warnings.push({
        section: "coverageGapAnalysis",
        toolName: "xray:createTest",
        message: `Could not assemble a valid test design from the generated scenarios; skipped Xray creation: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    if (testDesign && input.dryRun) {
      console.error(`Dry run: would create ${newScenarios.length} test(s) in Xray project "${projectKey}".`);
      for (const s of newScenarios) {
        console.error(`  - ${s.title}`);
      }
    } else if (testDesign) {
      const application = await applyTestDesignToXray({
        testDesign,
        ticketKey: input.issueKey,
        projectKey,
        xray: input.xray,
        jira: input.jira,
        dryRun: false,
        ...(input.linkTypeName ? { linkTypeName: input.linkTypeName } : {}),
        ...(input.linkDirection ? { linkDirection: input.linkDirection } : {}),
        ...(input.additionalFields ? { additionalFields: input.additionalFields } : {}),
      });
      newScenariosCreated = application.tests.filter((t) => t.status === "created").length;
      console.error(`Xray: created ${newScenariosCreated} test(s), linked to ${input.issueKey}.`);
      for (const test of application.tests) {
        const ref = test.key ? ` (${test.key})` : "";
        console.error(`  [${test.status}] ${test.title}${ref}`);
      }
    }
  }

  // Write context pack for reference
  const contextFiles = await writeContextPack(contextWithAcs, input.outDir);
  if (isCabinActive()) {
    const analysisPath = join(contextFiles.directory, "coverage-analysis.json");
    await writeFile(analysisPath, `${JSON.stringify({ analysis, newScenarios, warnings }, null, 2)}\n`, "utf8");
    registerCabinArtifacts({ directory: contextFiles.directory, paths: [analysisPath] });
  }

  return {
    analysisRating: analysis.rating,
    gapsFound: analysis.gaps.length,
    uncoveredCriteria: analysis.uncoveredCriteria.length,
    newScenariosCreated,
    commentPosted,
  };
}

function buildMinimalTestDesignPack(
  issueKey: string,
  context: ContextPack,
  scenarios: TestScenario[],
): TestDesignPack {
  const riskRanking = buildRiskRanking(scenarios);
  return TestDesignPackSchema.parse({
    schemaVersion: TEST_DESIGN_SCHEMA_VERSION,
    ticket: { key: context.ticket.key, title: context.ticket.title },
    outputMode: "gherkin",
    acceptanceCriteria: context.acceptanceCriteria ?? [],
    strategySummary: `Coverage gap analysis for ${issueKey}: ${scenarios.length} new test(s) to fill identified gaps.`,
    coverageGaps: [],
    scenarios,
    acCoverageMatrix: [],
    riskRanking,
    openQuestions: [],
    provenance: {
      generatedAt: new Date().toISOString(),
      issueKey,
      llm: { provider: "anthropic", model: "coverage-gap-analysis" },
      tools: [],
    },
    warnings: [],
  });
}

function buildRiskRanking(scenarios: TestScenario[]): RiskRankingEntry[] {
  const buckets: Record<RiskLevel, number[]> = { high: [], medium: [], low: [] };
  scenarios.forEach((scenario, index) => {
    buckets[scenario.risk].push(index);
  });
  return (["high", "medium", "low"] as const)
    .map((level) => ({ level, scenarioIndexes: buckets[level] }))
    .filter((entry) => entry.scenarioIndexes.length > 0);
}

function buildLlmClient(runtime: RuntimeConfig): LlmTextClient | undefined {
  if (!runtime.llm) {
    return undefined;
  }
  return createLlmTextClient(
    runtime.llm,
    runtime.observability ? { telemetry: runtime.observability.telemetry } : {},
  );
}

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      issue: { type: "string" },
      out: { type: "string" },
      repo: { type: "string" },
      config: { type: "string" },
      comment: { type: "boolean" },
      "create-tests": { type: "boolean" },
      "dry-run": { type: "boolean" },
      "test-fields": { type: "string" },
      reporter: { type: "string" },
      yes: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const issueKey = values.issue;
  if (!issueKey) {
    throw new CliError("--issue is required. Run 'manso analyse-coverage --help' for usage.");
  }

  const outDir = resolve(values.out ?? "./out");
  const runtime = await loadRuntimeConfig(values.config ? { configPath: values.config } : {});
  const provider = createJiraRestProviderFromRuntime(runtime);
  if (!provider) {
    throw new CliError(
      "Jira credentials are not configured. Set JIRA_URL, JIRA_USERNAME, and JIRA_API_TOKEN.",
    );
  }

  const llm = buildLlmClient(runtime);
  if (!llm) {
    throw new CliError(
      "An LLM API key is required for coverage analysis. Set LLM_API_KEY or OPENAI_API_KEY.",
    );
  }

  if (!runtime.xray) {
    throw new CliError(
      "Xray credentials are required to fetch linked test cases. Set XRAY_CLIENT_ID and XRAY_CLIENT_SECRET.",
    );
  }
  if (!runtime.jiraRest) {
    throw new CliError(
      "Jira REST credentials are required. Set JIRA_URL, JIRA_USERNAME, and JIRA_API_TOKEN.",
    );
  }

  const xray = new XrayCloudClient({
    baseUrl: runtime.xray.baseUrl,
    clientId: runtime.xray.clientId,
    clientSecret: runtime.xray.clientSecret,
  });
  const jira = new AtlassianRestClient({
    jira: {
      baseUrl: runtime.jiraRest.jiraUrl,
      username: runtime.jiraRest.jiraUsername,
      apiToken: runtime.jiraRest.jiraApiToken,
    },
  });

  const dryRun = values["dry-run"] ?? false;
  const postComment = values.comment ?? false;
  const createTests = values["create-tests"] ?? false;
  const yes = values.yes ?? false;

  if (createTests && !yes && !dryRun) {
    throw new CliError(
      "--create-tests requires --yes to confirm Xray uploads, or --dry-run to preview.",
    );
  }

  // Optional --repo: reuse the gherkin-authoring skill (repo override wins) and
  // the repo's existing step phrasings so generated tests follow house style.
  const repoRoot = values.repo ? resolve(values.repo) : undefined;
  const skills = await loadSkills({ phase: "design", ...(repoRoot ? { repoRoot } : {}) });
  const bindingSkillBody = skills.find((s) => s.name === "gherkin-authoring")?.body;
  let existingSteps: string[] | undefined;
  let configTestFields: Record<string, unknown> = {};
  if (repoRoot) {
    try {
      const library = await extractStepLibrary({ repoRoot });
      existingSteps = library.steps
        .slice(0, 80)
        .map((s) => `${s.keyword} ${s.examples[0] ?? s.normalized}`);
    } catch {
      /* step library is best-effort */
    }
    try {
      const agentConfig = await loadAgentConfig(repoRoot);
      configTestFields = agentConfig.xray.testFields;
    } catch {
      /* agent config is best-effort */
    }
  }
  // Extra Jira fields for created Test issues: repo xray.testFields overlaid by
  // an explicit `--test-fields '{...}'` (per-run, flag wins). Supplies
  // project-mandatory fields even without a --repo.
  const flagTestFields = parseJsonObjectArg(values["test-fields"], "--test-fields");
  const merged = mergeTestFields(configTestFields, values.reporter, flagTestFields);
  const additionalFields = Object.keys(merged).length > 0 ? merged : undefined;

  const auditPath = auditLogPath(outDir);
  await emitAudit({ path: auditPath, action: "run.started", actor: "analyse-coverage", target: issueKey, redactPatterns: [] });

  console.error(`Coverage Gap Analyser: fetching context for ${issueKey}...`);
  console.error(`LLM: ${llm.provider} ${llm.model}`);

  try {
    const result = await runAnalyseCoverage({
      issueKey,
      outDir,
      provider,
      llm,
      jira,
      xray,
      postComment,
      createTests: createTests && (yes || dryRun),
      dryRun,
      linkTypeName: runtime.xray.testIssueLinkType,
      linkDirection: runtime.xray.testIssueLinkDirection,
      ...(additionalFields ? { additionalFields } : {}),
      ...(bindingSkillBody ? { bindingSkillBody } : {}),
      ...(existingSteps && existingSteps.length > 0 ? { existingSteps } : {}),
    });

    await emitAudit({
      path: auditPath,
      action: "run.completed",
      actor: "analyse-coverage",
      target: issueKey,
      detail: {
        rating: result.analysisRating,
        gaps: result.gapsFound,
        uncoveredCriteria: result.uncoveredCriteria,
        newTests: result.newScenariosCreated,
        commentPosted: result.commentPosted,
      },
      redactPatterns: [],
    });

    console.log(`\nCoverage Analysis Complete:`);
    console.log(`  Rating: ${result.analysisRating}`);
    console.log(`  Gaps found: ${result.gapsFound}`);
    console.log(`  Uncovered criteria: ${result.uncoveredCriteria}`);
    console.log(`  New tests created: ${result.newScenariosCreated}`);
    console.log(`  Comment posted: ${result.commentPosted}`);

    return 0;
  } finally {
    await provider.close();
  }
}

const command: CommandModule = { run };
export default command;
