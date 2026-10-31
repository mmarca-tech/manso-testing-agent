import type { CommandResult } from "../../domain/implementationPack/schema.js";
import {
  runImplementationAgent,
  type ImplementationAgentRunner,
  type ImplementationAgentRunInput,
} from "../../integrations/llm/agentRunner.js";
import type { ObservabilityTelemetryConfig } from "../../integrations/llm/types.js";
import { resolveMcpServers, type McpServers } from "../../integrations/mcp/config.js";
import type { VcsAdapter, VcsCommentThread } from "../../integrations/vcs/adapter.js";
import type { GitPushAuth } from "../../integrations/git/branchCommit.js";
import { detectChangedFiles } from "../implementer/index.js";
import { runVerifier } from "../verifier/index.js";
import { parseUpdateMention, runKnowledgeUpdate } from "../learningEngine/knowledgeUpdate.js";
import type { LearningScope } from "../learningEngine/index.js";
import {
  classifyIntent,
  highestIteration,
  isResponderComment,
  markReply,
  parseMention,
  type MentionIntent,
} from "./mention.js";
import { buildFeedbackPrompt } from "./prompts.js";

export interface RespondToPrInput {
  issueKey: string;
  repoRoot: string;
  pullRequestId: number;
  adapter: VcsAdapter;
  /** The code agent used for feedback-scoped fixes. */
  runner: ImplementationAgentRunner;
  /** Verify command to re-run after a fix. */
  verifyCommand: string;
  /** Mention handle to listen for. Defaults to "@manso". */
  mention?: string;
  /** Max responder iterations across the PR's lifetime (loop-safety). */
  maxIterations?: number;
  /** MCP servers to expose to the fix agent (M11). */
  mcpServers?: McpServers;
  /** Extra env for the agent + verify processes. */
  env?: NodeJS.ProcessEnv;
  /** When true, classify + report but do not edit, verify, or post. */
  dryRun?: boolean;
  /** OTel telemetry config; when enabled the fix-agent runs are traced as
   *  Langfuse/Phoenix generations (session + token usage + cost). */
  telemetry?: ObservabilityTelemetryConfig;
  /**
   * Knowledge-update wiring (M13e). `@update-knowledge` proposes to this PR's
   * repo via {@link adapter}; `@update-agent` proposes to the Manso repo at
   * {@link agentRepoRoot} via {@link agentAdapter}. When the agent repo is not
   * configured, `@update-agent` is refused with a clear reply.
   */
  agentRepoRoot?: string;
  agentAdapter?: VcsAdapter;
  /** Token-based push auth for the project repo's proposal PR (else local creds). */
  pushAuth?: GitPushAuth;
  /** Token-based push auth for the agent repo's proposal PR (else local creds). */
  agentPushAuth?: GitPushAuth;
}

export interface RespondedThread {
  threadId: number;
  intent: MentionIntent | "update-knowledge" | "update-agent";
  instruction: string;
  /** What the responder did with this thread. */
  action: "fixed" | "replied" | "proposed" | "skipped";
  reply?: string;
  verification?: CommandResult;
  changedFiles?: string[];
  reason?: string;
}

export interface RespondToPrResult {
  pullRequestId: number;
  /** Iteration number used for this run's replies. */
  iteration: number;
  threads: RespondedThread[];
  warnings: string[];
}

const DEFAULT_MAX_ITERATIONS = 5;

/**
 * PR feedback loop (M12).
 *
 * Reads the PR's comment threads, finds threads whose latest human comment
 * addresses Manso and has not yet been answered, classifies the intent,
 * and either applies a feedback-scoped fix (re-verifying) or posts a reply.
 *
 * Loop-safety:
 *   - Never acts on its own comments (marker-tagged).
 *   - Skips a thread whose latest comment is already a responder reply.
 *   - Stops once the PR-wide iteration budget (`maxIterations`) is exhausted.
 */
export async function runRespondToPr(input: RespondToPrInput): Promise<RespondToPrResult> {
  const warnings: string[] = [];
  const mention = input.mention ?? "@manso";
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  if (!input.adapter.listPullRequestThreads || !input.adapter.postPullRequestComment) {
    return {
      pullRequestId: input.pullRequestId,
      iteration: 0,
      threads: [],
      warnings: [`VCS adapter "${input.adapter.kind}" does not support PR comment threads; cannot respond.`],
    };
  }

  let threads: VcsCommentThread[];
  try {
    threads = await input.adapter.listPullRequestThreads(input.pullRequestId);
  } catch (error) {
    return {
      pullRequestId: input.pullRequestId,
      iteration: 0,
      threads: [],
      warnings: [`Could not list PR threads: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const allBodies = threads.flatMap((thread) => thread.comments.map((comment) => comment.content));
  const priorIterations = highestIteration(allBodies);
  if (priorIterations >= maxIterations) {
    return {
      pullRequestId: input.pullRequestId,
      iteration: priorIterations,
      threads: [],
      warnings: [`PR iteration budget reached (${priorIterations}/${maxIterations}); not responding. Increase pr.maxIterationsPerPr to allow more.`],
    };
  }

  const iteration = priorIterations + 1;
  const responded: RespondedThread[] = [];
  let budgetLeft = maxIterations - priorIterations;
  const env = input.env ?? process.env;
  const { servers: mcpServers } = resolveMcpServers(input.mcpServers, env);

  for (const thread of threads) {
    // Knowledge-update triggers (@update-knowledge / @update-agent) take
    // priority — they turn a correction into a proposed rule PR.
    const update = decideUpdateThread(thread);
    if (update) {
      if (budgetLeft <= 0) {
        responded.push({ threadId: thread.id, intent: updateIntent(update.scope), instruction: update.instruction, action: "skipped", reason: "PR iteration budget exhausted this run." });
        continue;
      }
      const handled = await handleKnowledgeUpdate(input, thread.id, update.scope, update.instruction, iteration, warnings);
      responded.push(handled);
      budgetLeft -= 1;
      continue;
    }

    const decision = decideThread(thread, mention);
    if (!decision) {
      continue;
    }
    if (budgetLeft <= 0) {
      responded.push({ threadId: thread.id, intent: decision.intent, instruction: decision.instruction, action: "skipped", reason: "PR iteration budget exhausted this run." });
      continue;
    }

    if (decision.intent === "ignore") {
      continue;
    }

    if (decision.intent === "acknowledge") {
      const reply = "Thanks! Let me know if you'd like any changes to the generated tests.";
      await maybePost(input, thread.id, reply, iteration, warnings);
      responded.push({ threadId: thread.id, intent: decision.intent, instruction: decision.instruction, action: "replied", reply });
      budgetLeft -= 1;
      continue;
    }

    if (decision.intent === "explain") {
      const reply = `Here's the context you asked about:\n\n> ${decision.instruction}\n\nThis test was generated from the linked ticket's acceptance criteria. If you'd like a change, reply with what to adjust and I'll update the PR.`;
      await maybePost(input, thread.id, reply, iteration, warnings);
      responded.push({ threadId: thread.id, intent: decision.intent, instruction: decision.instruction, action: "replied", reply });
      budgetLeft -= 1;
      continue;
    }

    // intent === "fix"
    if (input.dryRun) {
      responded.push({ threadId: thread.id, intent: decision.intent, instruction: decision.instruction, action: "skipped", reason: "dry-run: would apply a feedback-scoped fix." });
      budgetLeft -= 1;
      continue;
    }

    const changedBefore = await detectChangedFiles(input.repoRoot);
    const prompt = buildFeedbackPrompt({
      issueKey: input.issueKey,
      repoRoot: input.repoRoot,
      feedback: decision.instruction,
      ...(decision.reviewer ? { reviewer: decision.reviewer } : {}),
      verifyCommand: input.verifyCommand,
      changedFiles: changedBefore,
    });

    const runInput: ImplementationAgentRunInput = {
      issueKey: input.issueKey,
      repoRoot: input.repoRoot,
      prompt,
      env,
      phase: "healing",
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    };

    const agent = await runImplementationAgent(input.runner, runInput, input.telemetry);
    const changedFiles = await detectChangedFiles(input.repoRoot);
    const verification = await runVerifier({ command: input.verifyCommand, repoRoot: input.repoRoot, ...(input.env ? { env: input.env } : {}) });

    const reply = buildFixReply(decision.instruction, agent, verification, changedFiles);
    await maybePost(input, thread.id, reply, iteration, warnings);
    responded.push({
      threadId: thread.id,
      intent: "fix",
      instruction: decision.instruction,
      action: "fixed",
      reply,
      verification,
      changedFiles,
    });
    budgetLeft -= 1;
  }

  return { pullRequestId: input.pullRequestId, iteration, threads: responded, warnings };
}

function updateIntent(scope: LearningScope): "update-knowledge" | "update-agent" {
  return scope === "agent" ? "update-agent" : "update-knowledge";
}

interface UpdateDecision {
  scope: LearningScope;
  instruction: string;
}

/**
 * Detect an unanswered `@update-knowledge` / `@update-agent` request on the
 * latest human comment of a thread (loop-safe: skips if the responder already
 * replied last).
 */
function decideUpdateThread(thread: VcsCommentThread): UpdateDecision | undefined {
  const last = thread.comments[thread.comments.length - 1];
  if (!last || isResponderComment(last.content)) {
    return undefined;
  }
  const parsed = parseUpdateMention(last.content);
  if (!parsed || parsed.instruction.length === 0) {
    return undefined;
  }
  return { scope: parsed.scope, instruction: parsed.instruction };
}

async function handleKnowledgeUpdate(
  input: RespondToPrInput,
  threadId: number,
  scope: LearningScope,
  instruction: string,
  iteration: number,
  warnings: string[],
): Promise<RespondedThread> {
  const intent = updateIntent(scope);

  // @update-agent needs a configured Manso repo to propose against.
  const repoRoot = scope === "agent" ? input.agentRepoRoot : input.repoRoot;
  const adapter = scope === "agent" ? input.agentAdapter : input.adapter;
  const pushAuth = scope === "agent" ? input.agentPushAuth : input.pushAuth;
  if (scope === "agent" && (!repoRoot || !adapter)) {
    const reply = "I can't propose a change to my own guidelines because the agent repo isn't configured. Set MANSO_AGENT_REPO to a local Manso checkout and try again.";
    await maybePost(input, threadId, reply, iteration, warnings);
    return { threadId, intent, instruction, action: "skipped", reply, reason: "MANSO_AGENT_REPO not configured." };
  }

  const result = await runKnowledgeUpdate({
    scope,
    instruction,
    repoRoot: repoRoot!,
    adapter: adapter!,
    ...(pushAuth ? { pushAuth } : {}),
    issueKey: input.issueKey,
    pullRequestId: input.pullRequestId,
    ...(input.dryRun ? { dryRun: true } : {}),
  });

  await maybePost(input, threadId, result.reply, iteration, warnings);
  return {
    threadId,
    intent,
    instruction,
    action: result.proposal.status === "proposed" ? "proposed" : "skipped",
    reply: result.reply,
  };
}

interface ThreadDecision {
  intent: MentionIntent;
  instruction: string;
  reviewer?: string;
}

/**
 * Decide whether a thread needs a response this run. Returns undefined when the
 * thread does not address Manso, or when the responder already had the last
 * word (loop-safety).
 */
function decideThread(thread: VcsCommentThread, mention: string): ThreadDecision | undefined {
  if (thread.comments.length === 0) {
    return undefined;
  }
  const last = thread.comments[thread.comments.length - 1];
  if (!last) {
    return undefined;
  }
  // The responder already replied last → nothing to do.
  if (isResponderComment(last.content)) {
    return undefined;
  }
  // Find the most recent human comment that addresses Manso.
  for (let i = thread.comments.length - 1; i >= 0; i -= 1) {
    const comment = thread.comments[i];
    if (!comment || isResponderComment(comment.content)) {
      continue;
    }
    const parsed = parseMention(comment.content, mention);
    if (parsed.mentioned) {
      return {
        intent: classifyIntent(parsed.instruction),
        instruction: parsed.instruction,
        ...(comment.author ? { reviewer: comment.author } : {}),
      };
    }
    break; // only consider the latest human comment
  }
  return undefined;
}

async function maybePost(
  input: RespondToPrInput,
  threadId: number,
  body: string,
  iteration: number,
  warnings: string[],
): Promise<void> {
  if (input.dryRun || !input.adapter.postPullRequestComment) {
    return;
  }
  const result = await input.adapter.postPullRequestComment({
    pullRequestId: input.pullRequestId,
    threadId,
    content: markReply(body, iteration),
  });
  if (result.status === "failed") {
    warnings.push(`Could not post reply to thread ${threadId}: ${result.message ?? "unknown error"}`);
  }
}

function buildFixReply(
  instruction: string,
  agent: CommandResult,
  verification: CommandResult,
  changedFiles: string[],
): string {
  const passed = verification.exitCode === 0;
  const lines: string[] = [];
  lines.push(passed ? "✅ I've applied the requested change and verification passed." : "⚠️ I applied the requested change, but verification is still failing.");
  lines.push("");
  lines.push(`**Requested:** ${instruction}`);
  if (changedFiles.length > 0) {
    lines.push("", "**Files changed:**");
    for (const file of changedFiles.slice(0, 25)) lines.push(`- ${file}`);
  }
  lines.push("", `**Verify (\`${verification.command}\`):** exit ${verification.exitCode} in ${verification.durationMs} ms`);
  if (!passed && verification.stderr) {
    lines.push("", "<details><summary>verify output</summary>", "", "```", verification.stderr.slice(-1500), "```", "", "</details>");
  }
  if (agent.exitCode !== 0 && agent.stderr) {
    lines.push("", `_Agent note: ${agent.stderr.slice(0, 300)}_`);
  }
  return lines.join("\n");
}
