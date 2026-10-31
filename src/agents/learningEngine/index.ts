import { createHash } from "node:crypto";
import {
  LEARNING_SCHEMA_VERSION,
  type LearningCategory,
  type LearningRecord,
  type LearningRecordSet,
  type LearningSource,
  type ProposedChange,
} from "../../domain/learningRecord/schema.js";
import { classifyLearning } from "./classify.js";

/**
 * Learning engine (M13).
 *
 * Consumes signals from the PR feedback loop and the heal/verify loops,
 * classifies each as transient or systemic, and — for systemic ones — drafts a
 * proposed guideline edit. Nothing here mutates the repository: proposals are
 * surfaced for a human to review and merge via a separate pull request
 * (see {@link buildGuidelineEdits} + the proposer).
 */

/**
 * Where a proposed rule lands:
 *   - "project" → the target repo's `.agents/guidelines/` (project knowledge).
 *   - "agent"   → the Manso repo's `proposed-guidelines/` (general rules a
 *                 maintainer folds into packaged skills).
 */
export type LearningScope = "project" | "agent";

export interface LearningSignal {
  source: LearningSource;
  /** The reviewer feedback or error excerpt. */
  text: string;
  pullRequestId?: number;
  /** When true, force a systemic classification (the reviewer explicitly asked
   *  to encode a rule via @update-knowledge / @update-agent). */
  forceSystemic?: boolean;
}

export interface CaptureLearningsInput {
  signals: LearningSignal[];
  issueKey?: string;
  /** Routing scope for proposed guideline edits. Defaults to "project". */
  scope?: LearningScope;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

/** Guideline filename per category; the directory comes from the scope. */
const GUIDELINE_FILE: Record<LearningCategory, string> = {
  selector: "selectors.md",
  timing: "waiting.md",
  "test-data": "test-data.md",
  assertion: "assertions.md",
  convention: "conventions.md",
  flaky: "flaky-tests.md",
  infrastructure: "infrastructure.md",
  other: "general.md",
};

/** Resolve the guideline target path for a scope + category. */
export function guidelineTargetPath(scope: LearningScope, category: LearningCategory): string {
  const dir = scope === "agent" ? "proposed-guidelines" : ".agents/guidelines";
  return `${dir}/${GUIDELINE_FILE[category]}`;
}

const GUIDELINE_HEADING: Record<LearningCategory, string> = {
  selector: "# Selector guidelines",
  timing: "# Waiting & timing guidelines",
  "test-data": "# Test-data guidelines",
  assertion: "# Assertion guidelines",
  convention: "# Conventions",
  flaky: "# Flaky-test notes",
  infrastructure: "# Infrastructure notes",
  other: "# General guidelines",
};

export function captureLearnings(input: CaptureLearningsInput): LearningRecordSet {
  const now = input.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const scope = input.scope ?? "project";

  const records: LearningRecord[] = input.signals
    .filter((signal) => signal.text.trim().length > 0)
    .map((signal) => {
      const { classification, category, rationale } = classifyLearning(signal.text);
      const effectiveClassification = signal.forceSystemic ? "systemic" : classification;
      const effectiveRationale = signal.forceSystemic
        ? "Explicitly requested as a rule by a reviewer."
        : rationale;
      const record: LearningRecord = {
        schemaVersion: LEARNING_SCHEMA_VERSION,
        id: learningId(signal),
        createdAt: generatedAt,
        source: signal.source,
        signal: signal.text.trim(),
        classification: effectiveClassification,
        category,
        rationale: effectiveRationale,
        applied: false,
        ...(input.issueKey ? { issueKey: input.issueKey } : {}),
        ...(signal.pullRequestId !== undefined ? { pullRequestId: signal.pullRequestId } : {}),
        ...(effectiveClassification === "systemic"
          ? { proposedChange: buildProposedChange(scope, category, signal.text) }
          : {}),
      };
      return record;
    });

  return {
    schemaVersion: LEARNING_SCHEMA_VERSION,
    generatedAt,
    ...(input.issueKey ? { issueKey: input.issueKey } : {}),
    records,
  };
}

function buildProposedChange(scope: LearningScope, category: LearningCategory, signal: string): ProposedChange {
  const rule = toRuleLine(signal);
  return {
    targetPath: guidelineTargetPath(scope, category),
    summary: rule,
    body: `- ${rule}`,
  };
}

/** Compress a free-form signal into a single guideline bullet. */
function toRuleLine(signal: string): string {
  const firstSentence = signal.trim().split(/(?<=[.!?])\s|\n/)[0] ?? signal.trim();
  const cleaned = firstSentence.replace(/^@\S+\s*/, "").replace(/\s+/g, " ").trim();
  const capped = cleaned.length > 160 ? `${cleaned.slice(0, 160)}…` : cleaned;
  return capped.length > 0 ? capped : signal.trim().slice(0, 160);
}

function learningId(signal: LearningSignal): string {
  const hash = createHash("sha256").update(`${signal.source}|${signal.text.trim()}`).digest("hex").slice(0, 10);
  return `learn-${signal.source}-${hash}`;
}

export interface GuidelineEdit {
  /** Repo-relative path of the guideline file to create or append to. */
  path: string;
  /** Markdown bullets to add (one per systemic record targeting this file). */
  additions: string[];
  /** Heading to use when the file does not yet exist. */
  heading: string;
}

/**
 * Group the systemic learnings into per-file guideline edits. Pure — produces
 * the *intended* additions; the proposer is responsible for reading any
 * existing file and raising the review PR. Transient/unknown records produce no
 * edit.
 */
export function buildGuidelineEdits(set: LearningRecordSet): GuidelineEdit[] {
  const byPath = new Map<string, GuidelineEdit>();
  for (const record of set.records) {
    if (record.classification !== "systemic" || !record.proposedChange) {
      continue;
    }
    const { targetPath, body } = record.proposedChange;
    const existing = byPath.get(targetPath);
    if (existing) {
      if (!existing.additions.includes(body)) {
        existing.additions.push(body);
      }
    } else {
      byPath.set(targetPath, {
        path: targetPath,
        additions: [body],
        heading: GUIDELINE_HEADING[record.category],
      });
    }
  }
  return [...byPath.values()];
}

/** True when a set carries at least one systemic, proposable learning. */
export function hasProposals(set: LearningRecordSet): boolean {
  return set.records.some((record) => record.classification === "systemic" && Boolean(record.proposedChange));
}
