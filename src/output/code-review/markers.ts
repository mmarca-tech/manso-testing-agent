import { createHash } from "node:crypto";
import type { CodeReviewFinding } from "../../domain/codeReview/schema.js";
import type { VcsCommentThread } from "../../integrations/vcs/adapter.js";

const PREFIX = "manso-review";

/** Hidden (HTML comment) marker identifying the single summary comment of a PR. */
export const SUMMARY_MARKER = `<!-- ${PREFIX}:summary -->`;

/** Stable marker for a finding: path, line, side and title, independent of the commit. */
export function findingMarker(finding: Pick<CodeReviewFinding, "filePath" | "line" | "side" | "title">): string {
  const path = (finding.filePath ?? "").trim().replace(/\\/g, "/").replace(/^(\.?\/)+/, "").toLowerCase();
  const key = [path, finding.line ?? "", finding.line ? (finding.side ?? "right") : "", finding.title.trim().toLowerCase()].join("|");
  return `<!-- ${PREFIX}:finding:${createHash("sha256").update(key).digest("hex").slice(0, 16)} -->`;
}

/** Append a hidden marker so later runs can recognise this comment. */
export function withMarker(content: string, marker: string): string {
  return `${content.trimEnd()}\n\n${marker}\n`;
}

export interface ExistingReviewComments {
  /** Markers of findings already posted on the PR (any thread status). */
  findingMarkers: ReadonlySet<string>;
  /** The most recent previously posted summary comment, if any. */
  summary?: { threadId: number; commentId: number; content: string };
}

/**
 * Markers are plain text that any PR participant can copy, so only comments
 * written by `trustedAuthorId` (the account Manso posts as) count. Without
 * a known identity nothing is trusted: a spoofed marker could otherwise suppress
 * a finding or make the next run try to overwrite someone else's comment.
 */
export function readExistingReviewComments(threads: VcsCommentThread[], trustedAuthorId?: string): ExistingReviewComments {
  const findingMarkers = new Set<string>();
  let summary: ExistingReviewComments["summary"];
  if (!trustedAuthorId) return { findingMarkers };
  for (const thread of threads) {
    for (const comment of thread.comments) {
      if (comment.authorId !== trustedAuthorId) continue;
      for (const match of comment.content.matchAll(new RegExp(`<!-- ${PREFIX}:finding:[0-9a-f]+ -->`, "g"))) {
        findingMarkers.add(match[0]);
      }
      if (comment.content.includes(SUMMARY_MARKER) && (!summary || thread.id >= summary.threadId)) {
        summary = { threadId: thread.id, commentId: comment.id, content: comment.content };
      }
    }
  }
  return { findingMarkers, ...(summary ? { summary } : {}) };
}
