import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runResearcher } from "../agents/researcher/index.js";
import { runAgenticRetrieval } from "../agents/researcher/agenticRetrieval.js";
import type { AcCoverageGate } from "../agents/coverageAuditor/index.js";
import { runTestArchitect } from "../agents/testArchitect/index.js";
import { buildEvidenceGraph } from "../context/evidenceGraph.js";
import { buildKnowledgeIndex } from "../context/knowledgeIndex.js";
import { uniqueBy } from "../shared/utils.js";
import { loadAgentConfig } from "../config/agentConfig.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../config/runtimeConfig.js";
import { auditLogPath, emitAudit } from "../policy/auditLog.js";
import { checkBudget } from "../policy/budget.js";
import { appendRunCost, costLedgerPath, readDayCost } from "../policy/costLedger.js";
import { estimateUsageCostUsd } from "../policy/modelPrices.js";
import { getStructuredOutputStats } from "../integrations/llm/structured.js";
import type { ContextProvider } from "../context/providerRegistry.js";
import { createJiraRestProviderFromRuntime } from "../context/providers/jiraRestProvider.js";
import { extractStepLibrary, resolveDesignRepo, type StepLibrary } from "../context/stepLibrary.js";
import { loadRepoGuidance, type RepoGuidanceFile } from "../context/repoGuidance.js";
import type { ContextPack } from "../domain/contextPack/schema.js";
import type { TestDesignPack, XrayApplication } from "../domain/testDesignPack/schema.js";
import { AtlassianRestClient } from "../integrations/atlassianRest/client.js";
import { createLlmTextClient } from "../integrations/llm/factory.js";
import { jiraIssueSessionId, withTelemetrySession } from "../integrations/llm/telemetry/observability.js";
import type { LlmTextClient } from "../integrations/llm/types.js";
import { XrayCloudClient } from "../integrations/xray/client.js";
import { applyTestDesignToXray } from "../integrations/xray/testDesignSink.js";
import { writeContextPack, type WriteResult } from "../output/context-pack/writer.js";
import { writeTestDesignPack, type WriteTestDesignResult } from "../output/test-design/writer.js";
import { CliError, mergeTestFields, parseBoolArg, parseJsonObjectArg } from "../shared/cli.js";
import type { CommandModule } from "./main.js";

const GATE_VALUES: AcCoverageGate[] = ["required", "warn", "off"];
function isGateValue(value: string): value is AcCoverageGate {
  return (GATE_VALUES as string[]).includes(value);
}

const HELP = `manso design-tests - extract context and design tests for a ticket.

Usage:
  manso design-tests --issue <KEY> [options]

Options:
  --issue <KEY>     Jira issue key (e.g. ABC-123). Required.
  --out <dir>       Output root directory. Defaults to ./out.
  --repo <path>     Target repo whose existing .feature steps are reused, and
                    whose .agents/skills override packaged skills. If omitted,
                    a repo named in the ticket's dev section is resolved via
                    MANSO_REPO_ROOTS.
  --config <path>   Optional JSON runtime-config file for non-secret overrides.
  --no-design       Skip the Test Architect; produce ContextPack only.
  --gate <level>    AC coverage gate: required | warn | off. Default required.
  --deep            Run the tool-using Researcher: the LLM drives retrieval over
                    the knowledge index and expands linked tickets before design.
  --dry-run         Skip Xray/Jira mutations; record what would have happened.
  --test-fields <json>  Extra Jira fields (field id → value) to set on created
                    Test issues, as a JSON object — e.g.
                    --test-fields '{"customfield_15714":170}'. Merged over the
                    repo's xray.testFields (this flag wins). Use for
                    project-mandatory fields, esp. on repo-less runs.
  --reporter <accountId>  Jira account id to set as Reporter on created Test
                    issues (e.g. {{initiator.accountId}} from an automation
                    rule, so tests are attributed to the triggering QA). The
                    authenticated account needs the project's "Modify Reporter"
                    permission. An explicit reporter in --test-fields wins.
  --derive-requirements <true|false>  M22: mine implied requirements beyond the
                    ACs. Default ON for every run (repo or repo-less); flag
                    overrides the repo config.
  --adversarial-critique <true|false>  M22: run the "what did we miss?" pass.
                    Default ON.
  --risk-coverage <level>  M22 risk/edge gate: required | warn | off.
                    Default warn.
  --yes             Confirm the Xray upload (required when Xray creds are set).
  -h, --help        Show this help.

When --repo (or a dev-section repo resolved via MANSO_REPO_ROOTS) is
available, Manso scans its .feature files and feeds the existing step
vocabulary to the author so scenarios reuse existing steps instead of
duplicating them.

Without an LLM API key, only the Researcher runs and produces a ContextPack.
With an LLM key, the Test Architect runs and produces a TestDesignPack plus
per-feature .feature files. When Xray creds (XRAY_CLIENT_ID / XRAY_CLIENT_SECRET)
are present AND --yes is passed, generated Gherkin scenarios are pushed to Xray
as Cucumber tests linked to the ticket. --dry-run skips the upload.
`;

export interface XrayUploadOptions {
  xray: XrayCloudClient;
  jira: AtlassianRestClient;
  projectKey: string;
  linkTypeName?: string;
  linkDirection?: "test-to-ticket" | "ticket-to-test";
  /** Extra Jira fields for created Test issues (from `.agents` xray.testFields). */
  additionalFields?: Record<string, unknown>;
  /** When true, record what would have happened without calling Xray or Jira. */
  dryRun?: boolean;
}

export interface DesignTestsInput {
  issueKey: string;
  outDir: string;
  provider: ContextProvider;
  /** When provided, the Test Architect runs after the Researcher. */
  llm?: LlmTextClient;
  /** Explicit target repo: existing .feature steps are reused, .agents/skills override. */
  repoRoot?: string;
  /** Map of repo name → local path, used to resolve a dev-section repo when --repo is absent. */
  repoRoots?: Record<string, string>;
  /** AC coverage gate. Defaults to "required" inside the Test Architect. */
  acCoverageGate?: AcCoverageGate;
  /** When provided, the Xray sink runs after the Test Architect. */
  xrayUpload?: XrayUploadOptions;
  /** Run the tool-using Researcher (agentic retrieval) before designing. */
  deepResearch?: boolean;
  /** From `context.linkedTicketDepth`: 0 disables related-ticket expansion. */
  linkedTicketDepth?: number;
  /** From `context.attachmentUnderstanding`: false skips attachment analysis. */
  attachmentUnderstanding?: boolean;
  /** From `testDesign.outputMode`: gherkin (Cucumber, default) or plain-english (Manual). */
  outputMode?: "gherkin" | "plain-english";
  /** M22 — extract derived requirements beyond the ACs (config `policy.design.deriveRequirements`). */
  deriveRequirements?: boolean;
  /** M22 — run the adversarial critique pass (config `policy.design.adversarialCritique`). */
  adversarialCritique?: boolean;
  /** M22 — risk/edge coverage gate (config `policy.gates.riskCoverage`). */
  riskCoverageGate?: AcCoverageGate;
  /**
   * Telemetry session id that groups every LLM span of this run under one
   * session in Langfuse/Phoenix. Defaults to `jira:<ISSUE-KEY>` when omitted.
   */
  sessionId?: string;
}

export interface StepLibrarySummary {
  repoRoot: string;
  source: "flag" | "dev-section";
  repository?: string;
  uniqueSteps: number;
  featureFiles: number;
}

export interface DesignTestsOutput extends WriteResult {
  context: ContextPack;
  testDesign?: TestDesignPack;
  testDesignFiles?: WriteTestDesignResult;
  application?: XrayApplication;
  /** Set when an existing-step library was loaded and fed to the author. */
  stepLibrary?: StepLibrarySummary;
}

/**
 * Library form of `design-tests`. Researcher (deterministic) is always run.
 * When an LLM is provided the Test Architect runs afterwards: AC extraction
 * enriches the ContextPack with `acceptanceCriteria`, then Gherkin scenarios
 * are designed and written as a TestDesignPack + `.feature` files.
 */
export async function runDesignTests(input: DesignTestsInput): Promise<DesignTestsOutput> {
  const sessionId = input.sessionId ?? jiraIssueSessionId(input.issueKey);
  return withTelemetrySession(sessionId, () => runDesignTestsInner(input));
}

async function runDesignTestsInner(input: DesignTestsInput): Promise<DesignTestsOutput> {
  const context = await runResearcher({
    issueKey: input.issueKey,
    provider: input.provider,
    // When an LLM is configured, let the Researcher use it to describe image
    // attachments (mockups/screenshots) as vision evidence.
    ...(input.llm ? { llm: input.llm } : {}),
    ...(input.linkedTicketDepth !== undefined ? { linkedTicketDepth: input.linkedTicketDepth } : {}),
    ...(input.attachmentUnderstanding !== undefined ? { attachmentUnderstanding: input.attachmentUnderstanding } : {}),
  });

  if (!input.llm) {
    const writeResult = await writeContextPack(context, input.outDir);
    return { ...writeResult, context };
  }

  // Tool-using Researcher (M10g): let the LLM drive retrieval over the
  // knowledge index and expand linked tickets, enriching the context before
  // the Test Architect. Opt-in via --deep to keep the default flow cheap.
  if (input.deepResearch) {
    const index = buildKnowledgeIndex(context);
    const research = await runAgenticRetrieval({
      context,
      index,
      provider: input.provider,
      llm: input.llm,
      warnings: context.warnings,
    });
    if (research.addedRelatedTickets.length > 0) {
      context.relatedTickets = uniqueBy(
        [...(context.relatedTickets ?? []), ...research.addedRelatedTickets],
        (related) => related.key,
      );
    }
    if (research.retrievalCitations.length > 0) {
      context.retrievalCitations = research.retrievalCitations;
    }
    context.evidenceGraph = buildEvidenceGraph(context);
  }

  // Resolve a target repo (explicit --repo, else a dev-section repo mapped in
  // repoRoots) and scan its existing .feature steps so the author can reuse them.
  const resolvedRepo = resolveDesignRepo({
    ...(input.repoRoot ? { explicit: input.repoRoot } : {}),
    development: context.development,
    ...(input.repoRoots ? { repoRoots: input.repoRoots } : {}),
  });
  let stepLibrary: StepLibrary | undefined;
  let stepLibrarySummary: StepLibrarySummary | undefined;
  let guidance: RepoGuidanceFile[] | undefined;
  if (resolvedRepo) {
    stepLibrary = await extractStepLibrary({ repoRoot: resolvedRepo.repoRoot });
    stepLibrarySummary = {
      repoRoot: resolvedRepo.repoRoot,
      source: resolvedRepo.source,
      ...(resolvedRepo.repository ? { repository: resolvedRepo.repository } : {}),
      uniqueSteps: stepLibrary.steps.length,
      featureFiles: stepLibrary.featureFileCount,
    };
    // M25: feed the repo's conventions AND learned rules (.agents/guidelines/)
    // into the design prompts — closing the learning loop on the design side.
    const loaded = await loadRepoGuidance(resolvedRepo.repoRoot);
    if (loaded.files.length > 0) guidance = loaded.files;
    for (const warning of loaded.warnings) console.warn(`! ${warning}`);
  }

  const architect = await runTestArchitect({
    context,
    llm: input.llm,
    ...(resolvedRepo ? { repoRoot: resolvedRepo.repoRoot } : {}),
    ...(input.acCoverageGate ? { acCoverageGate: input.acCoverageGate } : {}),
    ...(stepLibrary ? { stepLibrary } : {}),
    ...(guidance ? { guidance } : {}),
    ...(input.outputMode ? { outputMode: input.outputMode } : {}),
    ...(input.deriveRequirements !== undefined ? { deriveRequirements: input.deriveRequirements } : {}),
    ...(input.adversarialCritique !== undefined ? { adversarialCritique: input.adversarialCritique } : {}),
    ...(input.riskCoverageGate ? { riskCoverageGate: input.riskCoverageGate } : {}),
  });

  let testDesign = architect.testDesign;
  let application: XrayApplication | undefined;

  if (input.xrayUpload) {
    application = await applyTestDesignToXray({
      testDesign,
      ticketKey: input.issueKey,
      projectKey: input.xrayUpload.projectKey,
      xray: input.xrayUpload.xray,
      jira: input.xrayUpload.jira,
      ...(input.xrayUpload.linkTypeName ? { linkTypeName: input.xrayUpload.linkTypeName } : {}),
      ...(input.xrayUpload.linkDirection ? { linkDirection: input.xrayUpload.linkDirection } : {}),
      ...(input.xrayUpload.additionalFields ? { additionalFields: input.xrayUpload.additionalFields } : {}),
      ...(input.xrayUpload.dryRun !== undefined ? { dryRun: input.xrayUpload.dryRun } : {}),
    });
    testDesign = { ...testDesign, application };
  }

  const contextWrite = await writeContextPack(architect.contextWithCriteria, input.outDir);
  const testDesignWrite = await writeTestDesignPack(testDesign, input.outDir);

  return {
    ...contextWrite,
    context: architect.contextWithCriteria,
    testDesign,
    testDesignFiles: testDesignWrite,
    ...(application ? { application } : {}),
    ...(stepLibrarySummary ? { stepLibrary: stepLibrarySummary } : {}),
  };
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

/**
 * Best-effort read of a repo's `.agents` context knobs (linkedTicketDepth,
 * attachmentUnderstanding). Returns `{}` when the repo has no valid config, so
 * design-tests still runs issue-only with defaults.
 */
async function loadContextPolicy(
  repoRoot: string,
): Promise<{
  linkedTicketDepth?: number;
  attachmentUnderstanding?: boolean;
  outputMode?: "gherkin" | "plain-english";
  humanReviewBeforeUpload?: boolean;
  redactPatterns?: string[];
  testFields?: Record<string, unknown>;
  riskCoverageGate?: AcCoverageGate;
  deriveRequirements?: boolean;
  adversarialCritique?: boolean;
  budgets?: { maxCostPerRunUsd?: number | undefined; maxCostPerDayUsd?: number | undefined };
}> {
  try {
    const config = await loadAgentConfig(repoRoot);
    return {
      linkedTicketDepth: config.context.linkedTicketDepth,
      attachmentUnderstanding: config.context.attachmentUnderstanding,
      outputMode: config.testDesign.outputMode,
      humanReviewBeforeUpload: config.policy.gates.humanReviewBeforeUpload,
      redactPatterns: config.policy.redactPatterns,
      testFields: config.xray.testFields,
      riskCoverageGate: config.policy.gates.riskCoverage,
      deriveRequirements: config.policy.design.deriveRequirements,
      adversarialCritique: config.policy.design.adversarialCritique,
      budgets: config.policy.budgets,
    };
  } catch {
    return {};
  }
}

/**
 * Resolve the M22 knobs with ONE default regardless of run shape: flag wins,
 * then the repo's `.agents` config, then **on** (`warn` gate). Previously a
 * repo-backed run defaulted the passes on (schema defaults) while a repo-less
 * run defaulted them off — the "same" Jira rule behaved differently depending
 * only on whether `targetRepo` was set. Exported for tests.
 */
export function resolveM22Options(
  flags: { deriveRequirements?: boolean; adversarialCritique?: boolean; riskCoverageGate?: AcCoverageGate },
  policy: { deriveRequirements?: boolean; adversarialCritique?: boolean; riskCoverageGate?: AcCoverageGate },
): { deriveRequirements: boolean; adversarialCritique: boolean; riskCoverageGate: AcCoverageGate } {
  return {
    deriveRequirements: flags.deriveRequirements ?? policy.deriveRequirements ?? true,
    adversarialCritique: flags.adversarialCritique ?? policy.adversarialCritique ?? true,
    riskCoverageGate: flags.riskCoverageGate ?? policy.riskCoverageGate ?? "warn",
  };
}

/** Parse MANSO_REPO_ROOTS (a JSON object of repo name → local path). */
function parseRepoRoots(value: string | undefined): Record<string, string> | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, mapped] of Object.entries(parsed)) {
    if (typeof mapped === "string" && mapped.trim().length > 0) {
      result[key] = mapped;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Decide whether the Xray upload phase should run, given runtime credentials,
 * the ticket key, and the user's --dry-run / --yes choices.
 *
 *   - --dry-run with creds + LLM design → enabled with dryRun=true.
 *   - --yes with creds + LLM design → enabled with dryRun=false.
 *   - humanReviewBeforeUpload=false → enabled without --yes (auto-upload for
 *     unattended runs), unless --dry-run.
 *   - Anything else → undefined (skip, with a CLI message).
 */
/**
 * Whether a (non-dry-run) Xray upload is confirmed: either the user passed
 * `--yes`, or the repo's `policy.gates.humanReviewBeforeUpload` is `false`
 * (standing approval for unattended runs).
 */
export function xrayUploadConfirmed(yes: boolean, humanReviewBeforeUpload: boolean): boolean {
  return yes || humanReviewBeforeUpload === false;
}

function buildXrayUploadOptions(
  runtime: RuntimeConfig,
  issueKey: string,
  dryRun: boolean,
  yes: boolean,
  humanReviewBeforeUpload: boolean,
  testFields?: Record<string, unknown>,
): XrayUploadOptions | undefined {
  if (!runtime.xray || !runtime.jiraRest) {
    return undefined;
  }
  if (!dryRun && !xrayUploadConfirmed(yes, humanReviewBeforeUpload)) {
    return undefined;
  }

  const projectKey = issueKey.includes("-") ? issueKey.split("-", 1)[0] ?? issueKey : issueKey;
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

  return {
    xray,
    jira,
    projectKey,
    linkTypeName: runtime.xray.testIssueLinkType,
    linkDirection: runtime.xray.testIssueLinkDirection,
    ...(testFields && Object.keys(testFields).length > 0 ? { additionalFields: testFields } : {}),
    dryRun,
  };
}

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      issue: { type: "string" },
      out: { type: "string" },
      repo: { type: "string" },
      config: { type: "string" },
      "no-design": { type: "boolean" },
      gate: { type: "string" },
      deep: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "test-fields": { type: "string" },
      reporter: { type: "string" },
      "derive-requirements": { type: "string" },
      "adversarial-critique": { type: "string" },
      "risk-coverage": { type: "string" },
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
    throw new CliError("--issue is required. Run 'manso design-tests --help' for usage.");
  }

  let gate: AcCoverageGate | undefined;
  if (values.gate !== undefined) {
    if (!isGateValue(values.gate)) {
      throw new CliError(`Invalid --gate "${values.gate}". Expected one of: ${GATE_VALUES.join(", ")}`);
    }
    gate = values.gate;
  }

  // M22 overrides (flag wins over repo config; empty value = unset). Lets a
  // repo-less run (e.g. a Jira automation rule) enable derived requirements,
  // the adversarial critique, and the risk/edge gate without an .agents config.
  const deriveFlag = parseBoolArg(values["derive-requirements"], "--derive-requirements");
  const critiqueFlag = parseBoolArg(values["adversarial-critique"], "--adversarial-critique");
  let riskCoverageFlag: AcCoverageGate | undefined;
  if (values["risk-coverage"] !== undefined && values["risk-coverage"].trim().length > 0) {
    if (!isGateValue(values["risk-coverage"])) {
      throw new CliError(`Invalid --risk-coverage "${values["risk-coverage"]}". Expected one of: ${GATE_VALUES.join(", ")}`);
    }
    riskCoverageFlag = values["risk-coverage"];
  }

  const outDir = resolve(values.out ?? "./out");
  const runtime = await loadRuntimeConfig(values.config ? { configPath: values.config } : {});
  const provider = createJiraRestProviderFromRuntime(runtime);
  if (!provider) {
    throw new CliError(
      "Jira credentials are not configured. Set JIRA_URL, JIRA_USERNAME, and JIRA_API_TOKEN.",
    );
  }

  const llm = values["no-design"] ? undefined : buildLlmClient(runtime);
  const dryRun = values["dry-run"] ?? false;
  const yes = values.yes ?? false;
  const repoRoots = parseRepoRoots(process.env.MANSO_REPO_ROOTS);
  // When --repo is given, honour its .agents context knobs (best-effort).
  const contextPolicy = values.repo ? await loadContextPolicy(values.repo) : {};
  // Default to requiring human confirmation (--yes) unless the repo config opts
  // out via policy.gates.humanReviewBeforeUpload=false.
  const humanReviewBeforeUpload = contextPolicy.humanReviewBeforeUpload ?? true;
  // Extra Jira fields for created Test issues: repo `.agents` xray.testFields,
  // overlaid by an explicit `--test-fields '{...}'` (per-run, e.g. from a Jira
  // automation rule body). The flag wins per key. Lets project-mandatory fields
  // be supplied even on a repo-less (issue-only) run.
  const flagTestFields = parseJsonObjectArg(values["test-fields"], "--test-fields");
  const testFields = mergeTestFields(contextPolicy.testFields, values.reporter, flagTestFields);
  const xrayUpload = buildXrayUploadOptions(runtime, issueKey, dryRun, yes, humanReviewBeforeUpload, testFields);
  const auditPath = auditLogPath(outDir);
  const redactPatterns = contextPolicy.redactPatterns ?? [];

  try {
    await emitAudit({ path: auditPath, action: "run.started", actor: "design-tests", target: issueKey, redactPatterns });
    console.error(`Researcher: fetching context for ${issueKey}...`);
    if (llm) {
      console.error(`Test Architect: ${llm.provider} ${llm.model} — extracting ACs and designing scenarios...`);
    } else if (!values["no-design"]) {
      console.error("No LLM API key configured — skipping the Test Architect. ContextPack only.");
    }
    if (xrayUpload) {
      console.error(
        xrayUpload.dryRun
          ? `Xray sink: --dry-run (no mutations).`
          : `Xray sink: enabled — will create Cucumber tests in project "${xrayUpload.projectKey}" and link to ${issueKey}.`,
      );
    } else if (llm && runtime.xray && !yes && !dryRun) {
      console.error(
        `Xray sink: skipped — re-run with --yes to upload, or --dry-run to preview. Set XRAY_CLIENT_ID/SECRET to enable.`,
      );
    }

    const result = await runDesignTests({
      issueKey,
      outDir,
      provider,
      ...(llm ? { llm } : {}),
      ...(runtime.observability?.telemetry.sessionId
        ? { sessionId: runtime.observability.telemetry.sessionId }
        : {}),
      ...(values.repo ? { repoRoot: values.repo } : {}),
      ...(repoRoots ? { repoRoots } : {}),
      ...(gate ? { acCoverageGate: gate } : {}),
      ...(xrayUpload ? { xrayUpload } : {}),
      ...(values.deep ? { deepResearch: true } : {}),
      ...(contextPolicy.linkedTicketDepth !== undefined ? { linkedTicketDepth: contextPolicy.linkedTicketDepth } : {}),
      ...(contextPolicy.attachmentUnderstanding !== undefined
        ? { attachmentUnderstanding: contextPolicy.attachmentUnderstanding }
        : {}),
      ...(contextPolicy.outputMode ? { outputMode: contextPolicy.outputMode } : {}),
      // M22 — one default for every run shape (on, gate "warn"); flags then
      // repo config can still turn each off.
      ...resolveM22Options(
        {
          ...(deriveFlag !== undefined ? { deriveRequirements: deriveFlag } : {}),
          ...(critiqueFlag !== undefined ? { adversarialCritique: critiqueFlag } : {}),
          ...(riskCoverageFlag ? { riskCoverageGate: riskCoverageFlag } : {}),
        },
        contextPolicy,
      ),
    });

    if (result.stepLibrary) {
      const sl = result.stepLibrary;
      console.error(
        `Step reuse: loaded ${sl.uniqueSteps} existing step(s) from ${sl.featureFiles} feature file(s) in ${sl.repoRoot}` +
          (sl.source === "dev-section" ? ` (resolved from ticket dev section${sl.repository ? `: ${sl.repository}` : ""})` : ""),
      );
    } else if (llm && !values.repo) {
      console.error(
        "Step reuse: no repo resolved — pass --repo <path> (or set MANSO_REPO_ROOTS) to reuse existing feature steps.",
      );
    }

    // P2: meter the design phase. The text APIs report tokens but no cost, so
    // spend is estimated from the model price table and recorded in the same
    // cost ledger the implement phase uses. (Even --dry-run runs the LLM
    // passes, so this records on dry runs too.)
    const usageTotals = llm?.getAccumulatedUsage?.();
    if (usageTotals && usageTotals.calls > 0) {
      const designCostUsd = estimateUsageCostUsd({
        model: llm?.model,
        inputTokens: usageTotals.inputTokens,
        cachedInputTokens: usageTotals.cachedInputTokens,
        outputTokens: usageTotals.outputTokens,
      });
      if (designCostUsd !== undefined && designCostUsd > 0) {
        const ledgerPath = costLedgerPath(outDir);
        try {
          await appendRunCost(ledgerPath, { runCostUsd: designCostUsd, issueKey, command: "design-tests" });
        } catch {
          /* ledger write is best-effort */
        }
        const dayCost = await readDayCost(ledgerPath);
        const decision = checkBudget({ budget: contextPolicy.budgets ?? {}, runCostUsd: designCostUsd, dayCostUsd: dayCost });
        if (!decision.ok) {
          console.warn(`! Cost budget exceeded: ${decision.message}`);
          await emitAudit({ path: auditPath, action: "budget.breached", actor: "design-tests", target: issueKey, detail: { message: decision.message, runCostUsd: designCostUsd, dayCostUsd: dayCost }, redactPatterns });
        } else {
          console.error(`Cost (estimated): $${designCostUsd.toFixed(2)} this run · $${dayCost.toFixed(2)} today.`);
        }
      } else {
        console.error(
          `Design LLM usage: ${usageTotals.inputTokens} in / ${usageTotals.outputTokens} out tokens over ${usageTotals.calls} call(s) — no price for "${llm?.model}"; set MANSO_MODEL_PRICES to meter cost.`,
        );
      }
    }

    // M24c: surface the structured-output health of the design passes so the
    // parse-failure rate is visible (and the M23 eval can prove the gain).
    const structuredStats = getStructuredOutputStats();
    if (structuredStats.calls > 0) {
      console.error(
        `Structured outputs: ${structuredStats.calls} pass(es), ${structuredStats.retried} corrective retried, ${structuredStats.failed} failed.`,
      );
    }

    if (result.testDesign) {
      await emitAudit({ path: auditPath, action: "design.created", actor: "design-tests", target: issueKey, detail: { scenarios: result.testDesign.scenarios.length, outputMode: result.testDesign.outputMode }, redactPatterns });
    }
    if (result.application?.status === "applied") {
      const created = result.application.tests.filter((t) => t.status === "created").length;
      await emitAudit({ path: auditPath, action: "xray.uploaded", actor: "design-tests", target: issueKey, detail: { created, total: result.application.tests.length }, redactPatterns });
    }
    await emitAudit({ path: auditPath, action: "run.completed", actor: "design-tests", target: issueKey, detail: { hasDesign: Boolean(result.testDesign) }, redactPatterns });

    console.log(`Wrote ${result.jsonPath}`);
    console.log(`Wrote ${result.markdownPath}`);
    if (result.testDesignFiles) {
      console.log(`Wrote ${result.testDesignFiles.jsonPath}`);
      console.log(`Wrote ${result.testDesignFiles.markdownPath}`);
      for (const path of result.testDesignFiles.featurePaths) {
        console.log(`Wrote ${path}`);
      }
    }
    if (result.application) {
      const created = result.application.tests.filter((test) => test.status === "created").length;
      const skipped = result.application.tests.filter((test) => test.status === "skipped-existing").length;
      const failed = result.application.tests.filter((test) => test.status === "failed").length;
      console.log(
        `Xray application: ${result.application.status} — ${created} created, ${skipped} skipped, ${failed} failed`,
      );
      for (const test of result.application.tests) {
        const ref = test.key ? ` (${test.key})` : "";
        // Failure reasons must be IN the log — "14 failed" with no message cost
        // a build-artifact download to diagnose (MPORTAL reporter permission).
        const why = test.status === "failed" && test.message ? ` — ${test.message}` : "";
        console.log(`  [${test.status}] ${test.title}${ref}${why}`);
      }
      // M26 — design revision: what a re-run kept vs what looks obsolete now.
      const revision = result.application.revision;
      if (revision && (revision.kept.length > 0 || revision.retireCandidates.length > 0)) {
        console.log(
          `Revision: ${created} added, ${revision.kept.length} kept (already covered), ${revision.retireCandidates.length} possibly obsolete.`,
        );
        for (const keep of revision.kept) {
          console.log(`  [kept] ${keep.scenarioTitle} → ${keep.matchedKey ?? ""} "${keep.matchedTitle}" (${keep.similarity})`);
        }
        for (const retire of revision.retireCandidates) {
          console.log(`  [possibly obsolete] ${retire.key}: ${retire.title}`);
        }
      }
      const seenWarnings = new Set<string>();
      for (const warning of result.application.warnings) {
        if (seenWarnings.has(warning.message)) continue;
        seenWarnings.add(warning.message);
        console.warn(`! ${warning.message}`);
      }
      // A green step that created NOTHING it was asked to create is a silent
      // no-op (P1 class). Total sink failure → non-zero exit so the pipeline
      // shows red instead of "successful but no test cases".
      if (result.application.status === "applied" && failed > 0 && created === 0 && skipped === 0) {
        console.error("Xray upload failed for every scenario — see the messages above. Exiting non-zero.");
        return 1;
      }
    }
    if (result.context.warnings.length > 0) {
      console.warn(`Completed with ${result.context.warnings.length} warning(s).`);
    }
    return 0;
  } finally {
    await provider.close();
  }
}

const command: CommandModule = { run };
export default command;
