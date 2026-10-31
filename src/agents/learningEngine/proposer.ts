import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { commitChangesOnBranch, type GitPushAuth } from "../../integrations/git/branchCommit.js";
import type { VcsAdapter, VcsRaisePullRequestResult } from "../../integrations/vcs/adapter.js";
import { pathExists } from "../../shared/fsUtils.js";
import type { LearningRecordSet } from "../../domain/learningRecord/schema.js";
import { buildGuidelineEdits, hasProposals, type GuidelineEdit } from "./index.js";

/**
 * Learning proposer (M13).
 *
 * Turns systemic learnings into a **separate, human-reviewed pull request** that
 * edits `.agents/guidelines/*`. It never touches the implementation branch and
 * never auto-merges — the whole point is that a human approves a behaviour
 * change before it takes effect.
 */

export interface ProposeLearningsInput {
  repoRoot: string;
  set: LearningRecordSet;
  adapter: VcsAdapter;
  /** Branch for the proposal. Defaults to `manso/learnings/<KEY>`. */
  branchName?: string;
  targetBranch?: string;
  /** When true, write the edits but do not commit/push/raise. */
  dryRun?: boolean;
  /** Author override for the commit. */
  author?: string;
  /** Token-based push auth for unattended runs (else local git credentials). */
  pushAuth?: GitPushAuth;
}

export interface ProposeLearningsResult {
  status: "proposed" | "skipped" | "dry-run" | "failed";
  branch?: string;
  editedFiles: string[];
  pullRequest?: VcsRaisePullRequestResult;
  message?: string;
}

export async function proposeLearningsPr(input: ProposeLearningsInput): Promise<ProposeLearningsResult> {
  if (!hasProposals(input.set)) {
    return { status: "skipped", editedFiles: [], message: "No systemic learnings to propose." };
  }

  const edits = buildGuidelineEdits(input.set);
  const editedFiles = await applyGuidelineEdits(input.repoRoot, edits);
  const branch = input.branchName ?? `manso/learnings/${sanitizeBranch(input.set.issueKey ?? "general")}`;

  if (input.dryRun) {
    return {
      status: "dry-run",
      branch,
      editedFiles,
      message: `dry-run: would commit ${editedFiles.length} guideline file(s) on ${branch} and raise a review PR.`,
    };
  }

  const targetBranch = input.targetBranch ?? "main";
  const commit = await commitChangesOnBranch({
    repoRoot: input.repoRoot,
    branchName: branch,
    commitMessage: `Manso: propose guideline updates from learnings${input.set.issueKey ? ` (${input.set.issueKey})` : ""}`,
    push: true,
    ...(input.pushAuth ? { pushAuth: input.pushAuth } : {}),
    ...(input.author ? { author: input.author } : {}),
  });

  if (!commit.committed) {
    return { status: "skipped", branch, editedFiles, message: "No changes to commit (guidelines already cover these learnings)." };
  }

  const pullRequest = await input.adapter.raisePullRequest({
    branch: commit.branch,
    targetBranch,
    title: `Manso: proposed guideline updates${input.set.issueKey ? ` for ${input.set.issueKey}` : ""}`,
    description: buildPrDescription(input.set, editedFiles),
  });

  return {
    status: pullRequest.status === "failed" ? "failed" : "proposed",
    branch: commit.branch,
    editedFiles,
    pullRequest,
    ...(pullRequest.message ? { message: pullRequest.message } : {}),
  };
}

/**
 * Append each edit's additions to its guideline file (creating the file with a
 * heading + provenance note when absent). Skips an addition already present in
 * the file so re-runs are idempotent. Returns the repo-relative paths touched.
 */
export async function applyGuidelineEdits(repoRoot: string, edits: GuidelineEdit[]): Promise<string[]> {
  const touched: string[] = [];

  for (const edit of edits) {
    const absolute = join(repoRoot, edit.path);
    const exists = await pathExists(absolute);
    let current = exists ? await readFile(absolute, "utf8") : "";

    const newAdditions = edit.additions.filter((addition) => !current.includes(addition.trim()));
    if (newAdditions.length === 0 && exists) {
      continue;
    }

    if (!exists) {
      current = `${edit.heading}\n\n<!-- Proposed by Manso from captured learnings. Review before merging. -->\n\n`;
    } else if (!current.endsWith("\n")) {
      current += "\n";
    }

    const next = `${current}${newAdditions.join("\n")}\n`;
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, next, "utf8");
    touched.push(edit.path);
  }

  return touched;
}

function buildPrDescription(set: LearningRecordSet, editedFiles: string[]): string {
  const lines: string[] = [];
  lines.push("This PR proposes guideline updates that Manso learned from review feedback and test failures.");
  lines.push("");
  lines.push("**Please review before merging** — these rules will steer future test generation.");
  lines.push("");
  lines.push("## Edited files");
  for (const file of editedFiles) lines.push(`- \`${file}\``);
  lines.push("");
  lines.push("## Source learnings");
  for (const record of set.records) {
    if (record.classification === "systemic") {
      lines.push(`- **[${record.category}]** ${record.signal}`);
    }
  }
  return lines.join("\n");
}

function sanitizeBranch(value: string): string {
  return value.replace(/[^A-Za-z0-9._/-]/g, "-");
}
