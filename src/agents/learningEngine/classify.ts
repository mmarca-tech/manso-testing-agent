import type { LearningCategory, LearningClassification } from "../../domain/learningRecord/schema.js";

/**
 * Learning classification (M13).
 *
 * Decides whether a feedback/failure signal is **transient** (a one-off — flaky
 * run, infra blip, a fix that does not generalise) or **systemic** (a recurring
 * pattern that should be encoded into a guideline/skill so future runs avoid
 * it). Rule-based and deterministic so the decision is auditable and testable;
 * an LLM classifier can refine this later without changing the contract.
 */

export interface Classification {
  classification: LearningClassification;
  category: LearningCategory;
  rationale: string;
}

interface CategoryRule {
  category: LearningCategory;
  /** Default classification when this category matches. */
  classification: LearningClassification;
  patterns: RegExp[];
  rationale: string;
}

// Transient categories first so a flaky/infra signal is not mis-read as a
// convention to encode.
const RULES: CategoryRule[] = [
  {
    category: "flaky",
    classification: "transient",
    patterns: [/\bflak(y|e|iness)\b/i, /\bintermittent\b/i, /\brandom(ly)? fail/i, /\bre-?ran?\b/i, /\bretry\b/i, /\bpassed on retry\b/i],
    rationale: "Signal describes a flaky/intermittent failure — treat as transient, not a rule.",
  },
  {
    category: "infrastructure",
    classification: "transient",
    patterns: [/\btimeout\b/i, /\bECONN/i, /\bnetwork\b/i, /\b5\d\d\b/, /\brate limit/i, /\bunavailable\b/i, /\benvironment\b/i, /\bCI runner\b/i],
    rationale: "Signal points at infrastructure/network/CI — transient, not a code convention.",
  },
  {
    category: "selector",
    classification: "systemic",
    patterns: [/\bselector\b/i, /\blocator\b/i, /\bgetByRole\b/i, /\bdata-?testid\b/i, /\bcss\b/i, /\bxpath\b/i, /\bnth-child\b/i],
    rationale: "Selector/locator feedback recurs across UI tests — encode a selector guideline.",
  },
  {
    category: "timing",
    classification: "systemic",
    patterns: [/\bwait(s|ing|fortimeout)?\b/i, /\bsleep\b/i, /\bthread\.sleep\b/i, /\bhard-?coded? (wait|delay|timeout)\b/i, /\bpoll\b/i],
    rationale: "Timing/wait feedback is a cross-cutting convention — encode a waiting guideline.",
  },
  {
    category: "test-data",
    classification: "systemic",
    patterns: [/\bhard-?coded?\b/i, /\bfactory\b/i, /\bfixture\b/i, /\btest data\b/i, /\bseed(ed)?\b/i, /\btenant id\b/i, /\baccount id\b/i],
    rationale: "Test-data feedback affects every scenario — encode a data-setup guideline.",
  },
  {
    category: "assertion",
    classification: "systemic",
    patterns: [/\bassert(ion)?\b/i, /\bexpect(ed)?\b/i, /\bverif(y|ication)\b/i, /\bcheck (that|the)\b/i],
    rationale: "Assertion feedback is reusable guidance — encode an assertion guideline.",
  },
  {
    category: "convention",
    classification: "systemic",
    patterns: [/\bconvention\b/i, /\bnaming\b/i, /\bstyle\b/i, /\bpattern\b/i, /\bstructure\b/i, /\balways\b/i, /\bnever\b/i, /\bprefer\b/i],
    rationale: "Feedback states a general convention — encode it as a guideline.",
  },
];

export function classifyLearning(signal: string): Classification {
  const text = signal.trim();
  if (text.length === 0) {
    return { classification: "unknown", category: "other", rationale: "Empty signal; nothing to classify." };
  }

  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return { classification: rule.classification, category: rule.category, rationale: rule.rationale };
    }
  }

  return {
    classification: "unknown",
    category: "other",
    rationale: "No transient or systemic pattern matched; left for human review.",
  };
}
