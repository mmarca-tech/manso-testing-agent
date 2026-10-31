import { describe, expect, it } from "vitest";
import { findingMarker, readExistingReviewComments, SUMMARY_MARKER, withMarker } from "../src/output/code-review/markers.js";

const finding = { title: "Wrong output", filePath: "/src/a.ts", line: 4, side: "right" as const };

describe("review comment markers", () => {
  it("is stable across path spelling, title case and omitted default side", () => {
    expect(findingMarker({ ...finding, filePath: "src/a.ts", title: "WRONG output", side: undefined })).toBe(findingMarker(finding));
  });
  it("differs by line, side and title", () => {
    const base = findingMarker(finding);
    expect(findingMarker({ ...finding, line: 5 })).not.toBe(base);
    expect(findingMarker({ ...finding, side: "left" })).not.toBe(base);
    expect(findingMarker({ ...finding, title: "Other" })).not.toBe(base);
  });
  it("finds finding markers and the latest summary across threads", () => {
    const marker = findingMarker(finding);
    const existing = readExistingReviewComments([
      { id: 1, comments: [{ id: 10, authorId: "bot", content: withMarker("inline", marker) }] },
      { id: 2, comments: [{ id: 20, authorId: "bot", content: withMarker("old summary", SUMMARY_MARKER) }] },
      { id: 3, comments: [{ id: 30, authorId: "bot", content: withMarker("newer summary", SUMMARY_MARKER) }] },
      { id: 4, comments: [{ id: 40, authorId: "human", content: "human comment" }] },
    ], "bot");
    expect(existing.findingMarkers.has(marker)).toBe(true);
    expect(existing.summary).toMatchObject({ threadId: 3, commentId: 30 });
  });

  it("ignores markers copied into other people's comments", () => {
    const marker = findingMarker(finding);
    const existing = readExistingReviewComments([
      { id: 1, comments: [{ id: 10, authorId: "attacker", content: withMarker("looks like a finding", marker) }] },
      { id: 2, comments: [{ id: 20, authorId: "attacker", content: withMarker("fake summary", SUMMARY_MARKER) }] },
      { id: 3, comments: [{ id: 30, content: withMarker("no author at all", SUMMARY_MARKER) }] },
    ], "bot");
    expect(existing.findingMarkers.size).toBe(0);
    expect(existing.summary).toBeUndefined();
  });

  it("trusts nothing when the posting identity is unknown", () => {
    const existing = readExistingReviewComments([
      { id: 1, comments: [{ id: 10, authorId: "bot", content: withMarker("inline", findingMarker(finding)) }] },
    ]);
    expect(existing.findingMarkers.size).toBe(0);
    expect(existing.summary).toBeUndefined();
  });
});
