import type { VcsAdapter } from "../../integrations/vcs/adapter.js";
import type { GitPushAuth } from "../../integrations/git/branchCommit.js";
import { captureLearnings, type LearningScope } from "./index.js";
import { proposeLearningsPr, type ProposeLearningsResult } from "./proposer.js";

/**
 * Knowledge-update triggers (M13e).
 *
 * Two explicit PR-comment handles let a reviewer turn a correction into a
 * durable rule:
 *   - `@update-knowledge <rule>` → project knowledge → a review PR editing the
 *     **target repo's** `.agents/guidelines/`.
 *   - `@update-agent <rule>` → a general rule → a review PR editing the
 *     **Manso repo's** `proposed-guidelines/` (a maintainer folds it into a
 *     packaged skill).
 *
 * Both paths only ever *propose* via a separate, human-reviewed PR — the
 * reviewer's text is untrusted and is never applied automatically.
 */

export const UPDATE_HANDLES: ReadonlyArray<{ handle: string; scope: LearningScope }> = [
  { handle: "@update-knowledge", scope: "project" },
  { handle: "@update-agent", scope: "agent" },
];

export interface ParsedUpdateMention {
  scope: LearningScope;
  handle: string;
  instruction: string;
}

/**
 * Detect an `@update-knowledge` / `@update-agent` handle and extract the rule
 * text after it. Returns undefined when neither handle is present.
 */
export function parseUpdateMention(text: string): ParsedUpdateMention | undefined {
  const lower = text.toLowerCase();
  let best: { handle: string; scope: LearningScope; at: number } | undefined;
  for (const { handle, scope } of UPDATE_HANDLES) {
    const at = lower.indexOf(handle);
    if (at >= 0 && (best === undefined || at < best.at)) {
      best = { handle, scope, at };
    }
  }
  if (!best) {
    return undefined;
  }
  const after = text.slice(best.at + best.handle.length);
  const instruction = after.replace(/^\s*[:,\-]?\s*/, "").trim();
  return { scope: best.scope, handle: best.handle, instruction };
}

export interface RunKnowledgeUpdateInput {
  scope: LearningScope;
  instruction: string;
  /** Repo whose files the proposal edits (project repo or the agent repo). */
  repoRoot: string;
  /** Adapter for that repo's platform. */
  adapter: VcsAdapter;
  /** Token-based push auth for unattended runs (else local git credentials). */
  pushAuth?: GitPushAuth;
  issueKey?: string;
  pullRequestId?: number;
  dryRun?: boolean;
}

export interface KnowledgeUpdateResult {
  scope: LearningScope;
  proposal: ProposeLearningsResult;
  /** A human-readable reply suitable for posting back in the PR thread. */
  reply: string;
}

/**
 * Capture an explicitly-requested rule (forced systemic) and raise the scoped
 * proposal PR. The category classifier still routes it to the right guideline
 * file; the reviewer's tag decides project vs agent scope.
 */
export async function runKnowledgeUpdate(input: RunKnowledgeUpdateInput): Promise<KnowledgeUpdateResult> {
  const set = captureLearnings({
    scope: input.scope,
    ...(input.issueKey ? { issueKey: input.issueKey } : {}),
    signals: [
      {
        source: "pr-feedback",
        text: input.instruction,
        forceSystemic: true,
        ...(input.pullRequestId !== undefined ? { pullRequestId: input.pullRequestId } : {}),
      },
    ],
  });

  const branchName = `manso/${input.scope === "agent" ? "update-agent" : "update-knowledge"}/${sanitizeBranch(input.issueKey ?? "general")}`;

  const proposal = await proposeLearningsPr({
    repoRoot: input.repoRoot,
    set,
    adapter: input.adapter,
    branchName,
    ...(input.pushAuth ? { pushAuth: input.pushAuth } : {}),
    ...(input.dryRun ? { dryRun: true } : {}),
  });

  return { scope: input.scope, proposal, reply: buildReply(input.scope, proposal) };
}

function buildReply(scope: LearningScope, proposal: ProposeLearningsResult): string {
  const where = scope === "agent" ? "Manso's own guidelines" : "this repo's `.agents/guidelines/`";
  switch (proposal.status) {
    case "proposed":
      return `📝 Proposed a rule update to ${where} for review${proposal.pullRequest?.url ? `: ${proposal.pullRequest.url}` : ""}. It won't take effect until a human merges it.`;
    case "dry-run":
      return `📝 (dry-run) Would propose a rule update to ${where}: ${proposal.editedFiles.join(", ") || "no files"}.`;
    case "skipped":
      return `No rule change proposed — ${proposal.message ?? "nothing to add (already covered)."}`;
    case "failed":
      return `⚠️ Could not raise the rule-update PR: ${proposal.message ?? "unknown error"}.`;
    default:
      return `Rule-update status: ${proposal.status}.`;
  }
}

function sanitizeBranch(value: string): string {
  return value.replace(/[^A-Za-z0-9._/-]/g, "-");
}
