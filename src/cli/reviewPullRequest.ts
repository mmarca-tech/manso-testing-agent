import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runResearcher } from "../agents/researcher/index.js";
import { readGuidelines } from "../agents/pullRequestReviewer/guidelines.js";
import { buildPullRequestReviewRequest, detectJiraIssueKey, REVIEW_MAX_OUTPUT_TOKENS, runPullRequestReviewer } from "../agents/pullRequestReviewer/index.js";
import { loadAgentConfig, type AgentConfig } from "../config/agentConfig.js";
import { loadRuntimeConfig } from "../config/runtimeConfig.js";
import { createJiraRestProviderFromRuntime } from "../context/providers/jiraRestProvider.js";
import type { ContextProvider } from "../context/providerRegistry.js";
import type { ContextPack } from "../domain/contextPack/schema.js";
import { CODE_REVIEW_SCHEMA_VERSION, CodeReviewPackSchema, type CodeReviewPack, type CodeReviewResult } from "../domain/codeReview/schema.js";
import { createLlmTextClient } from "../integrations/llm/factory.js";
import type { LlmTextClient } from "../integrations/llm/types.js";
import { withTelemetrySession } from "../integrations/llm/telemetry/observability.js";
import type { VcsAdapter } from "../integrations/vcs/adapter.js";
import { resolveVcsAdapter, vcsTokensFromRuntime } from "../integrations/vcs/resolve.js";
import { writeCodeReviewPack } from "../output/code-review/writer.js";
import { renderCodeReviewFinding, renderCodeReviewSummary } from "../output/code-review/renderer.js";
import { findingMarker, readExistingReviewComments, SUMMARY_MARKER, withMarker } from "../output/code-review/markers.js";
import { appendAuditEntry, auditLogPath, type AuditAction } from "../policy/auditLog.js";
import { checkBudget } from "../policy/budget.js";
import { appendRunCost, costLedgerPath, readDayCost } from "../policy/costLedger.js";
import { acquireLock, LockBusyError } from "../policy/lockFile.js";
import { estimateUsageCostUsd, resolveModelPrice } from "../policy/modelPrices.js";
import { buildRedactor, redactValue } from "../policy/redaction.js";
import { CliError } from "../shared/cli.js";
import type { CommandModule } from "./main.js";

const HELP = `manso review-pull-request - proactively review a PR against Jira and repository context.

Usage:
  manso review-pull-request --repo <path> --pr <id> [--issue <KEY>] [options]

Options:
  --repo <path>    Target checkout with .agents/manso.config.json.
                   Defaults to BUILD_SOURCESDIRECTORY or the current directory.
  --pr <id>        PR id; defaults to SYSTEM_PULLREQUEST_PULLREQUESTID / NUMBER.
  --issue <KEY>    Override ticket detection (source branch, title, description).
  --out <dir>      Report root; defaults to ./out (reports under pr-<id>/).
  --no-comment     Write reports without posting inline or summary comments.
  --dry-run        Same mutation guard as --no-comment; still calls the LLM.
  --config <path>  Runtime config override.
  -h, --help       Show help.

Supports Azure DevOps and GitHub via the checkout's remote. Requires a VCS
token and LLM credentials; Jira credentials are required when a key is found.
Posts located findings inline plus ONE summary with unlocated findings.
Line anchors are validated against the reviewed diff (left/right side).
Re-runs are idempotent: findings already on the PR (hidden marker) are skipped and
the previous summary comment is updated in place instead of reposted.
Never edits code or votes.
Missing/truncated evidence or an unavailable LLM means needs-human-review.
Cost is estimated from the model price table (override via MANSO_MODEL_PRICES)
and recorded in the shared cost ledger. Configured budgets require a known
model price and are checked BEFORE the paid request and before comment posting.
SYSTEM_ACCESSTOKEN is supported for Azure PR-validation pipelines.
`;

export interface ReviewPullRequestInput {
  pullRequestId: number;
  issueKey?: string;
  outDir: string;
  adapter: VcsAdapter;
  provider?: ContextProvider;
  llm: LlmTextClient;
  policy: AgentConfig["policy"];
  guidelines?: string;
  guidelineWarnings?: string[];
  noComment?: boolean;
  dryRun?: boolean;
}

export interface ReviewPullRequestOutput {
  pack: CodeReviewPack;
  jsonPath: string;
  markdownPath: string;
  commentPosted: boolean;
  inlineCommentsPosted: number;
  /** Findings skipped because an earlier run already posted them. */
  inlineCommentsSkipped: number;
  failed: boolean;
}

/** Proactive review without code changes, using Manso's governance seams. */
export async function runReviewPullRequest(input: ReviewPullRequestInput): Promise<ReviewPullRequestOutput> {
  return withTelemetrySession(`pr:${input.adapter.kind}:${input.pullRequestId}`, () => runReview(input));
}

async function runReview(input: ReviewPullRequestInput): Promise<ReviewPullRequestOutput> {
  if (!Number.isSafeInteger(input.pullRequestId) || input.pullRequestId <= 0) throw new CliError("PR id must be a positive safe integer.");
  if (!input.adapter.getPullRequest || !input.adapter.getPullRequestDiff) throw new CliError("VCS adapter does not support proactive PR evidence.");
  if (!input.noComment && !input.dryRun && !input.adapter.postPullRequestComment) throw new CliError("VCS adapter cannot post PR comments; use --no-comment.");
  const redactor = buildRedactor(input.policy.redactPatterns);
  const audit = (action: AuditAction, detail: Record<string, unknown>) => appendAuditEntry({
    path: auditLogPath(input.outDir), action, actor: "review-pull-request",
    target: String(input.pullRequestId), detail, redactPatterns: input.policy.redactPatterns,
  });
  const budgets = input.policy.budgets;
  const modelPrice = resolveModelPrice(input.llm.model);
  if ((budgets.maxCostPerRunUsd !== undefined || budgets.maxCostPerDayUsd !== undefined) && !modelPrice) {
    throw new CliError(`review-pull-request budgets need a known price for model "${input.llm.model}"; set MANSO_MODEL_PRICES. Refusing to treat unknown LLM cost as zero.`);
  }
  const ledger = costLedgerPath(input.outDir);
  await mkdir(dirname(ledger), { recursive: true });
  // Serialize this verb's ledger checks and writes. A live lock is never
  // removed or bypassed, but one left behind by a crashed run (dead PID or
  // older than the stale timeout) is taken over, with a warning.
  const lockPath = `${ledger}.review.lock`;
  let lock;
  try { lock = await acquireLock(lockPath); }
  catch (error) {
    throw new CliError(error instanceof LockBusyError
      ? "Review cost ledger is locked or inaccessible; retry after the active review completes."
      : `Review cost ledger lock failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await audit("run.started", { dryRun: input.dryRun ?? false, noComment: input.noComment ?? false });
    const dayCost = await readDayCost(ledger, undefined, { strict: true });
    const pullRequest = await input.adapter.getPullRequest(input.pullRequestId);
    const issueKey = input.issueKey ?? detectJiraIssueKey([pullRequest.sourceBranch, pullRequest.title, pullRequest.description]);
    if (issueKey && !/^[A-Z][A-Z0-9_]+-\d+$/i.test(issueKey)) throw new CliError("Invalid Jira issue key.");
    let ticket: ContextPack | undefined;
    if (issueKey) {
      if (!input.provider) throw new CliError("A Jira key was detected but Jira credentials are missing.");
      // Context enrichment remains deterministic: no unbudgeted attachment or
      // vision LLM calls outside the single governed review request.
      ticket = await runResearcher({ issueKey, provider: input.provider, attachmentUnderstanding: false });
    }
    const diff = await input.adapter.getPullRequestDiff(input.pullRequestId);
    const built = buildPullRequestReviewRequest({
      pullRequest, diff, ...(ticket ? { ticket } : {}),
      ...(input.guidelines ? { guidelines: input.guidelines } : {}),
      redactPatterns: input.policy.redactPatterns,
      ...(input.guidelineWarnings ? { guidelineWarnings: input.guidelineWarnings } : {}),
    });
    const warnings = [...built.warnings, ...(ticket?.warnings.map((warning) => `${warning.section}: ${warning.message}`) ?? [])];
    // Cost model shared with the other verbs: the client's accumulated usage
    // priced against the model price table (MANSO_MODEL_PRICES).
    const estimateCost = (usage: { inputTokens: number; cachedInputTokens?: number; outputTokens: number }) =>
      estimateUsageCostUsd({ model: input.llm.model, ...usage });
    // UTF-8 bytes conservatively bound text tokens without deployment-specific
    // tokenizers. Reserve the complete output cap, not an optimistic average.
    const reservedCost = estimateCost({
      inputTokens: Buffer.byteLength(built.request.systemPrompt) + Buffer.byteLength(built.request.userPrompt) + 1024,
      outputTokens: REVIEW_MAX_OUTPUT_TOKENS,
    });
    const preflight = checkBudget({ budget: budgets, runCostUsd: reservedCost ?? 0, dayCostUsd: dayCost + (reservedCost ?? 0) });
    if (!preflight.ok) {
      await audit("budget.breached", { message: preflight.message, phase: "before-llm" });
      throw new CliError(`Review halted before the LLM call: ${preflight.message}`);
    }
    const usageBefore = input.llm.getAccumulatedUsage?.();
    let failed = false;
    let review: CodeReviewResult;
    try {
      review = await runPullRequestReviewer({
        llm: input.llm, request: built.request, diff: built.evidenceDiff,
        incompleteEvidence: warnings.length > 0,
      });
    } catch (error) {
      failed = true;
      warnings.push(redactor.redact(`Automated review failed: ${error instanceof Error ? error.message : String(error)}`));
      review = {
        summary: "Automated review was unavailable. Manual review is required.",
        businessImpact: "Unknown.", technicalAssessment: "Unknown.", approvalRecommendation: "needs-human-review",
        findings: [], questions: ["Please complete a manual review; automated review did not succeed."],
      };
    }
    // Spend of this run only: the client may have been used before. Clients
    // count a call before parsing its text, so malformed paid responses count too.
    const usageAfter = input.llm.getAccumulatedUsage?.();
    const usage = usageAfter ? {
      inputTokens: usageAfter.inputTokens - (usageBefore?.inputTokens ?? 0),
      cachedInputTokens: usageAfter.cachedInputTokens - (usageBefore?.cachedInputTokens ?? 0),
      outputTokens: usageAfter.outputTokens - (usageBefore?.outputTokens ?? 0),
    } : undefined;
    const measured = usage !== undefined && (usage.inputTokens > 0 || usage.outputTokens > 0);
    const runCost = measured ? estimateCost(usage) : reservedCost;
    if (!measured) {
      failed = true;
      review.approvalRecommendation = "needs-human-review";
      warnings.push("Measured token usage unavailable; reserved cost recorded conservatively when pricing is configured.");
    }
    if (!modelPrice) warnings.push(`No price known for model "${input.llm.model}"; USD cost is unknown (set MANSO_MODEL_PRICES; no cost limits configured).`);
    if (runCost !== undefined) await appendRunCost(ledger, { runCostUsd: runCost, command: "review-pull-request", ...(issueKey ? { issueKey } : {}) });
    const after = checkBudget({ budget: budgets, runCostUsd: runCost ?? 0, dayCostUsd: dayCost + (runCost ?? 0) });
    if (!after.ok) {
      failed = true;
      review.approvalRecommendation = "needs-human-review";
      warnings.push(`Budget exceeded; comment suppressed: ${after.message}`);
      await audit("budget.breached", { message: after.message, phase: "after-llm" });
    }
    const currentPr = await input.adapter.getPullRequest(input.pullRequestId);
    if (currentPr.sourceCommit !== pullRequest.sourceCommit || currentPr.targetCommit !== pullRequest.targetCommit) {
      failed = true;
      review.approvalRecommendation = "needs-human-review";
      warnings.push("PR commits changed during review; comment suppressed. Rerun against the current PR.");
    }
    if (!pullRequest.sourceCommit && review.findings.some((finding) => finding.filePath && finding.line)) {
      warnings.push("Reviewed source commit is unavailable; located findings will remain in the summary instead of being posted inline.");
    }
    // Recorded after the reviewer ran: it says nothing about the review evidence.
    if (lock.tookOverStale) warnings.push(`Took over an abandoned review lock: ${lock.tookOverStale}.`);
    const pack = CodeReviewPackSchema.parse(redactValue({
      schemaVersion: CODE_REVIEW_SCHEMA_VERSION, pullRequest,
      ...(ticket ? { ticket } : {}), ...(issueKey ? { detectedTicketKey: issueKey } : {}),
      diff, review, warnings,
      provenance: {
        generatedAt: new Date().toISOString(), llm: { provider: input.llm.provider, model: input.llm.model },
        ...(runCost !== undefined ? { runCostUsd: runCost } : {}),
      },
    }, redactor));
    const written = await writeCodeReviewPack(pack, input.outDir);
    await audit("pr.reviewed", { recommendation: review.approvalRecommendation, findings: review.findings.length, failed });
    let commentPosted = false;
    const inlineFindingIndexes = new Set<number>();
    let inlineCommentsSkipped = 0;
    const stale = currentPr.sourceCommit !== pullRequest.sourceCommit || currentPr.targetCommit !== pullRequest.targetCommit;
    if (!input.noComment && !input.dryRun && after.ok && !stale) {
      const assertCurrentCommits = async () => {
        const latest = await input.adapter.getPullRequest!(input.pullRequestId);
        if (latest.sourceCommit !== pullRequest.sourceCommit || latest.targetCommit !== pullRequest.targetCommit) {
          throw new CliError(`PR commits changed while posting review; stopped after ${postedInline} inline comment(s). Rerun review.`);
        }
      };
      // Re-runs (e.g. every push in a PR-validation pipeline) must not repost
      // what an earlier run already posted: read the existing threads first.
      // Markers are copyable text, so only comments written by the account this
      // run posts as are trusted; otherwise a PR participant could suppress
      // findings or make the run try to overwrite their own comment.
      let existing = readExistingReviewComments([]);
      const trustedAuthorId = await input.adapter.getAuthenticatedUserId?.().catch(() => undefined);
      if (!input.adapter.listPullRequestThreads) {
        console.error("Warning: VCS adapter cannot list PR threads; earlier review comments cannot be deduplicated.");
      } else if (!trustedAuthorId) {
        console.error("Warning: could not determine which PR comments Manso wrote; earlier review comments are not deduplicated, so repeated comments are possible.");
      } else {
        try { existing = readExistingReviewComments(await input.adapter.listPullRequestThreads(input.pullRequestId), trustedAuthorId); }
        catch (error) {
          throw new CliError(redactor.redact(`Could not read existing PR threads; not posting to avoid duplicate comments: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      let postedInline = 0;
      // Also covers a model returning the same finding twice in one response.
      const seenFindingMarkers = new Set(existing.findingMarkers);
      for (const [index, finding] of pack.review.findings.entries()) {
        if (!finding.filePath || !finding.line || !pullRequest.sourceCommit) continue;
        const marker = findingMarker(finding);
        if (seenFindingMarkers.has(marker)) {
          inlineFindingIndexes.add(index);
          inlineCommentsSkipped += 1;
          continue;
        }
        await assertCurrentCommits();
        const inline = {
          path: finding.filePath, line: finding.line, side: finding.side ?? "right",
          sourceCommit: pullRequest.sourceCommit,
        } as const;
        await audit("pr.review-comment-requested", { kind: "inline", path: inline.path, line: inline.line, side: inline.side });
        const posted = await input.adapter.postPullRequestComment!({
          pullRequestId: input.pullRequestId, content: withMarker(renderCodeReviewFinding(finding), marker), inline,
        });
        if (posted.status !== "posted") {
          throw new CliError(redactor.redact(`Inline review comment was not posted after ${postedInline} successful inline comment(s): ${posted.message ?? posted.status}`));
        }
        seenFindingMarkers.add(marker);
        inlineFindingIndexes.add(index);
        postedInline += 1;
        await audit("pr.review-commented", {
          kind: "inline", path: inline.path, line: inline.line, side: inline.side,
          threadId: posted.threadId ?? 0, commentId: posted.commentId ?? 0,
        });
      }
      await assertCurrentCommits();
      const summaryContent = withMarker(renderCodeReviewSummary(pack, inlineFindingIndexes), SUMMARY_MARKER);
      if (existing.summary && existing.summary.content.trimEnd() === summaryContent.trimEnd()) {
        // Nothing changed since the previous run: leave the existing summary as is.
        commentPosted = true;
      } else {
        const update = existing.summary && input.adapter.updatePullRequestComment ? existing.summary : undefined;
        const kind = update ? "summary-update" : "summary";
        await audit("pr.review-comment-requested", { kind, recommendation: review.approvalRecommendation });
        // Update the earlier summary in place instead of opening another thread.
        const result = update
          ? await input.adapter.updatePullRequestComment!({
            pullRequestId: input.pullRequestId, threadId: update.threadId, commentId: update.commentId, content: summaryContent,
          })
          : await input.adapter.postPullRequestComment!({ pullRequestId: input.pullRequestId, content: summaryContent });
        if (result.status !== "posted") throw new CliError(redactor.redact(`PR review comment was not posted: ${result.message ?? result.status}`));
        commentPosted = true;
        await audit("pr.review-commented", { kind, threadId: result.threadId ?? 0, commentId: result.commentId ?? 0 });
      }
    }
    await audit("run.completed", { failed, commentPosted, inlineCommentsPosted: inlineFindingIndexes.size - inlineCommentsSkipped, inlineCommentsSkipped });
    return { pack, ...written, commentPosted, inlineCommentsPosted: inlineFindingIndexes.size - inlineCommentsSkipped, inlineCommentsSkipped, failed };
  } catch (error) {
    await audit("run.completed", { failed: true, message: redactor.redact(error instanceof Error ? error.message : String(error)) });
    throw new CliError(redactor.redact(error instanceof Error ? error.message : String(error)));
  } finally {
    await lock.release();
  }
}

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv, allowPositionals: false,
    options: {
      repo: { type: "string" }, pr: { type: "string" }, issue: { type: "string" },
      out: { type: "string" }, config: { type: "string" },
      "no-comment": { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) { console.log(HELP); return 0; }
  const idText = values.pr ?? process.env.SYSTEM_PULLREQUEST_PULLREQUESTID ?? process.env.SYSTEM_PULLREQUEST_PULLREQUESTNUMBER;
  if (!idText || !/^[1-9]\d*$/.test(idText) || !Number.isSafeInteger(Number(idText))) throw new CliError("--pr must be a positive safe integer (or set the Azure PR pipeline variable).");
  if (values.issue && !/^[A-Z][A-Z0-9_]+-\d+$/i.test(values.issue)) throw new CliError("--issue must be a Jira issue key.");
  const repoRoot = resolve(values.repo ?? process.env.BUILD_SOURCESDIRECTORY ?? ".");
  const config = await loadAgentConfig(repoRoot);
  const runtime = await loadRuntimeConfig(values.config ? { configPath: values.config } : {});
  if (!runtime.llm) throw new CliError("review-pull-request requires LLM credentials.");
  const resolution = await resolveVcsAdapter(repoRoot, vcsTokensFromRuntime(runtime));
  if (!resolution.ok) throw new CliError(`review-pull-request: ${resolution.reason}`);
  const provider = createJiraRestProviderFromRuntime(runtime);
  try {
    const guidelines = await readGuidelines(repoRoot);
    const result = await runReviewPullRequest({
      pullRequestId: Number(idText), outDir: resolve(values.out ?? "out"), adapter: resolution.adapter,
      ...(values.issue ? { issueKey: values.issue.toUpperCase() } : {}), ...(provider ? { provider } : {}),
      llm: createLlmTextClient(runtime.llm, { telemetry: runtime.observability?.telemetry }),
      policy: config.policy, guidelines: guidelines.text, guidelineWarnings: guidelines.warnings,
      noComment: values["no-comment"] ?? false, dryRun: values["dry-run"] ?? false,
    });
    console.log(`Wrote ${result.jsonPath}\nWrote ${result.markdownPath}`);
    console.log(`Recommendation: ${result.pack.review.approvalRecommendation}; ${result.inlineCommentsPosted} inline comment(s) posted, ${result.inlineCommentsSkipped} already present; summary ${result.commentPosted ? "posted" : "not posted"}.`);
    return result.failed ? 1 : 0;
  } finally { await provider?.close(); }
}

export default { run } satisfies CommandModule;
