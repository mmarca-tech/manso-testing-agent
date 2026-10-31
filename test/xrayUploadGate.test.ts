import { describe, expect, it } from "vitest";
import { xrayUploadConfirmed } from "../src/cli/designTests.js";

describe("xrayUploadConfirmed (M21 — humanReviewBeforeUpload gate)", () => {
  it("requires --yes when humanReviewBeforeUpload is true (default)", () => {
    expect(xrayUploadConfirmed(false, true)).toBe(false); // no --yes → not confirmed
    expect(xrayUploadConfirmed(true, true)).toBe(true); // --yes → confirmed
  });

  it("auto-confirms (no --yes needed) when humanReviewBeforeUpload is false", () => {
    expect(xrayUploadConfirmed(false, false)).toBe(true);
    expect(xrayUploadConfirmed(true, false)).toBe(true);
  });
});
