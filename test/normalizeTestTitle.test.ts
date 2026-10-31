import { describe, expect, it } from "vitest";
import { normalizeTestTitle } from "../src/shared/utils.js";

describe("normalizeTestTitle (P1-3 duplicate detection)", () => {
  it("ignores case, punctuation, and extra whitespace", () => {
    expect(normalizeTestTitle("Customer selects an eligible 3-instalment plan.")).toBe(
      normalizeTestTitle("customer selects   an eligible 3 instalment Plan"),
    );
  });

  it("treats unicode dashes/quotes the same as ASCII ones", () => {
    expect(normalizeTestTitle("Notifications page — 12‑month boundary")).toBe(
      normalizeTestTitle('Notifications page "12-month" boundary'),
    );
  });

  it("does NOT conflate genuinely different titles", () => {
    expect(normalizeTestTitle("Unread notifications show an indicator")).not.toBe(
      normalizeTestTitle("Read notifications show no indicator"),
    );
  });

  it("keeps titles that differ ONLY by a comparison operator distinct", () => {
    // These previously collapsed to "balance 0" / "discount 50" and the second
    // of each pair was dropped as a duplicate.
    expect(normalizeTestTitle("Balance = 0")).not.toBe(normalizeTestTitle("Balance != 0"));
    expect(normalizeTestTitle("Balance >= 0")).not.toBe(normalizeTestTitle("Balance > 0"));
    expect(normalizeTestTitle("Discount > 50%")).not.toBe(normalizeTestTitle("Discount < 50%"));
    // unicode operator forms canonicalize to the same token as their ASCII form
    expect(normalizeTestTitle("Balance ≠ 0")).toBe(normalizeTestTitle("Balance != 0"));
    expect(normalizeTestTitle("Qty ≥ 5")).toBe(normalizeTestTitle("Qty >= 5"));
    // but a symbol that is pure punctuation still collapses
    expect(normalizeTestTitle("Opens the page.")).toBe(normalizeTestTitle("Opens the page"));
  });
});
