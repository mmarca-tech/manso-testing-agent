import { describe, expect, it } from "vitest";
import { matchAgainstReference, ReferenceSetSchema, type ReferenceSet } from "../src/eval/referenceMatch.js";

function ref(titles: string[], threshold?: number): ReferenceSet {
  return { cases: titles.map((title) => ({ title })), ...(threshold !== undefined ? { threshold } : {}) };
}

describe("matchAgainstReference (M23 semantic recall)", () => {
  it("matches paraphrased titles (short design title vs long QA row)", () => {
    // Real pairs from the MPORTAL-2073 golden case.
    const result = matchAgainstReference(
      [
        "Notification read state persists after refresh and re-login",
        "Notification read state is isolated per user",
        "Existing portal header elements remain functional after adding notification icon",
      ],
      ref([
        "Notification read state persists across page refresh and logout/re-login",
        "Read state is user-specific — reading as User A does not affect User B's unread indicator or count",
        "No regression on existing portal header elements after adding the notification icon(client selector/ help)",
      ]),
    );
    expect(result.recall).toBe(1);
    expect(result.unmatchedReferences).toEqual([]);
    expect(result.beyondReference).toEqual([]);
  });

  it("reports unmatched references and does not penalize extra scenarios", () => {
    const result = matchAgainstReference(
      [
        "Login form rejects an invalid password",
        "Session cookie is renewed on activity", // beyond the reference — extra coverage
      ],
      ref([
        "Invalid password is rejected on the login form",
        "Password reset email arrives within a minute", // not covered by the design
      ]),
    );
    expect(result.recall).toBe(0.5);
    expect(result.unmatchedReferences).toEqual(["Password reset email arrives within a minute"]);
    expect(result.beyondReference).toEqual(["Session cookie is renewed on activity"]);
  });

  it("assigns greedily 1:1 — one scenario cannot cover two reference cases", () => {
    const result = matchAgainstReference(
      ["Notifications page lists notifications from the past 12 months"],
      ref([
        "Notifications page lists all notifications from the past 12 months",
        "Notifications older than 12 months are excluded from the notifications page",
      ]),
    );
    expect(result.matched).toHaveLength(1);
    expect(result.recall).toBe(0.5);
  });

  it("does not match unrelated titles (min shared informative tokens)", () => {
    const result = matchAgainstReference(
      ["Merchant exports the settlement report as CSV"],
      ref(["Notification icon shows an unread indicator"]),
    );
    expect(result.recall).toBe(0);
    expect(result.matched).toEqual([]);
  });

  it("respects a per-reference threshold override", () => {
    const design = ["Notification content with long title and body wraps without truncation"];
    const reference = ["Notification with long title and long body text — the text flows on the next line"];
    // This real pair scores 0.5: matched at the 0.45 default, dropped by a
    // stricter per-reference threshold.
    expect(matchAgainstReference(design, ref(reference)).recall).toBe(1);
    expect(matchAgainstReference(design, ref(reference, 0.6)).recall).toBe(0);
  });

  it("is deterministic for identical input", () => {
    const design = ["A b c d", "E f g h"];
    const reference = ref(["a b c x", "e f g y"]);
    const first = matchAgainstReference(design, reference);
    const second = matchAgainstReference(design, reference);
    expect(second).toEqual(first);
  });
});

describe("ReferenceSetSchema", () => {
  it("accepts the documented shape and rejects empty case lists", () => {
    expect(
      ReferenceSetSchema.safeParse({ source: "QA table", cases: [{ title: "t" }] }).success,
    ).toBe(true);
    expect(ReferenceSetSchema.safeParse({ cases: [] }).success).toBe(false);
    expect(ReferenceSetSchema.safeParse({ cases: [{ title: "" }] }).success).toBe(false);
  });
});
