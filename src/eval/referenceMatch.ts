import { z } from "zod";

/**
 * Reference matching for the eval harness (M23).
 *
 * A golden case can carry a **human-written reference** — the test cases a QA
 * engineer wrote for the same ticket. This module matches the design's
 * scenario titles against that reference and reports **recall**: what fraction
 * of the human cases the design covered.
 *
 * Deliberately deterministic (no LLM), following the scorer's philosophy —
 * a golden run is reproducible and a regression is attributable. The matcher
 * was tuned on real data (MPORTAL‑2073: an 18‑row QA table vs the agent's
 * design):
 *   - lowercase → light suffix stemming → generic English stopwords
 *   - dynamic corpus stopwords (tokens in >70% of all titles carry no signal
 *     for THIS case, e.g. "notification" on a notifications ticket)
 *   - pair score = mean(containment, Dice) — containment handles the
 *     long-QA-row vs short-design-title asymmetry, Dice guards tiny sets
 *   - greedy 1:1 assignment (one design scenario cannot cover two reference
 *     cases), threshold default 0.45
 *
 * Extra design scenarios that match no reference are reported as
 * `beyondReference` — informational, NEVER penalized: designing beyond the
 * human floor is exactly what M22 is for.
 */

export const ReferenceCaseSchema = z
  .object({
    /** The human-written test case (title or one-line description). */
    title: z.string().min(1),
    notes: z.string().optional(),
  })
  .strict();

export const ReferenceSetSchema = z
  .object({
    /** Where the reference came from (e.g. "QA scenario table, MPORTAL-2073 comment, Divya Suresh Pai"). */
    source: z.string().optional(),
    notes: z.string().optional(),
    /** Per-case match-threshold override (0..1). */
    threshold: z.number().min(0).max(1).optional(),
    cases: z.array(ReferenceCaseSchema).min(1),
  })
  .strict();

export type ReferenceCase = z.infer<typeof ReferenceCaseSchema>;
export type ReferenceSet = z.infer<typeof ReferenceSetSchema>;

export interface ReferenceMatchPair {
  referenceTitle: string;
  scenarioTitle: string;
  /** Blended similarity 0..1. */
  similarity: number;
}

export interface ReferenceMatchResult {
  /** matched references / total references, 0..1. */
  recall: number;
  matched: ReferenceMatchPair[];
  /** Human reference cases no design scenario covered — the actionable list. */
  unmatchedReferences: string[];
  /** Design scenarios beyond the human reference (informational, not penalized). */
  beyondReference: string[];
  threshold: number;
}

export const DEFAULT_MATCH_THRESHOLD = 0.45;

const STOPWORDS = new Set(
  (
    "a an the of to in on for is are and or with when then that this it its as by from be " +
    "will not no should can does do after across into at was were has have"
  ).split(" "),
);

/** Light suffix stemming: updates/updated/updating → updat; titled/title → titl. */
function stem(word: string): string {
  let w = word;
  for (const suffix of ["ing", "ed", "es", "ly", "s"]) {
    if (w.length > suffix.length + 2 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w.length > 3 && w.endsWith("e") ? w.slice(0, -1) : w;
}

/** Informative token set for one title. */
function tokenize(title: string): Set<string> {
  const cleaned = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ");
  const out = new Set<string>();
  for (const word of cleaned.split(" ")) {
    if (word.length === 0 || STOPWORDS.has(word)) continue;
    out.add(stem(word));
  }
  return out;
}

/**
 * Tokens present in most of the titles carry no discriminating signal for this
 * case (the ticket's domain word, e.g. "notification" on a notifications
 * ticket). The 70% cutoff is deliberately high so that on small corpora,
 * merely-common words ("read", "state") are not dropped. Only applied when the
 * corpus is big enough to make frequency meaningful.
 */
function corpusStopwords(docs: Set<string>[]): Set<string> {
  if (docs.length < 4) return new Set();
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const token of doc) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const cutoff = docs.length * 0.7;
  return new Set([...df.entries()].filter(([, count]) => count > cutoff).map(([token]) => token));
}

/** Blended similarity: mean of containment (∩/min) and Dice (2∩/(|A|+|B|)). */
function pairSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  if (intersection < 2) return 0; // one shared token is noise, not a match
  const containment = intersection / Math.min(a.size, b.size);
  const dice = (2 * intersection) / (a.size + b.size);
  return (containment + dice) / 2;
}

/**
 * Match design scenario titles against the human reference (greedy 1:1,
 * highest similarity first).
 */
export function matchAgainstReference(
  scenarioTitles: string[],
  reference: ReferenceSet,
): ReferenceMatchResult {
  const threshold = reference.threshold ?? DEFAULT_MATCH_THRESHOLD;
  const refTitles = reference.cases.map((c) => c.title);

  const allDocs = [...refTitles, ...scenarioTitles].map(tokenize);
  const drop = corpusStopwords(allDocs);
  const strip = (doc: Set<string>) => new Set([...doc].filter((t) => !drop.has(t)));
  const refDocs = allDocs.slice(0, refTitles.length).map(strip);
  const designDocs = allDocs.slice(refTitles.length).map(strip);

  const pairs: Array<{ similarity: number; ref: number; design: number }> = [];
  for (let r = 0; r < refDocs.length; r += 1) {
    for (const [d, designDoc] of designDocs.entries()) {
      const refDoc = refDocs[r];
      if (!refDoc) continue;
      const similarity = pairSimilarity(refDoc, designDoc);
      if (similarity >= threshold) pairs.push({ similarity, ref: r, design: d });
    }
  }
  pairs.sort((a, b) => b.similarity - a.similarity);

  const usedRef = new Set<number>();
  const usedDesign = new Set<number>();
  const matched: ReferenceMatchPair[] = [];
  for (const pair of pairs) {
    if (usedRef.has(pair.ref) || usedDesign.has(pair.design)) continue;
    usedRef.add(pair.ref);
    usedDesign.add(pair.design);
    matched.push({
      referenceTitle: refTitles[pair.ref] ?? "",
      scenarioTitle: scenarioTitles[pair.design] ?? "",
      similarity: Math.round(pair.similarity * 100) / 100,
    });
  }

  const unmatchedReferences = refTitles.filter((_, i) => !usedRef.has(i));
  const beyondReference = scenarioTitles.filter((_, i) => !usedDesign.has(i));
  const recall = refTitles.length === 0 ? 1 : matched.length / refTitles.length;

  return {
    recall: Math.round(recall * 1000) / 1000,
    matched,
    unmatchedReferences,
    beyondReference,
    threshold,
  };
}
