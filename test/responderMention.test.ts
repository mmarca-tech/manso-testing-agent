import { describe, expect, it } from "vitest";
import {
  RESPONDER_MARKER,
  classifyIntent,
  highestIteration,
  isResponderComment,
  markReply,
  parseMention,
} from "../src/agents/responder/mention.js";

describe("parseMention", () => {
  it("detects the handle and extracts the instruction", () => {
    expect(parseMention("@manso please fix the login selector")).toEqual({
      mentioned: true,
      instruction: "please fix the login selector",
    });
  });

  it("is case-insensitive and strips a leading separator", () => {
    expect(parseMention("Hey @Manso: update the assertion").instruction).toBe("update the assertion");
  });

  it("returns not-mentioned when the handle is absent", () => {
    expect(parseMention("looks good to me")).toEqual({ mentioned: false, instruction: "" });
  });

  it("supports a custom handle", () => {
    expect(parseMention("@qa-bot rework this", "@qa-bot").mentioned).toBe(true);
  });
});

describe("classifyIntent", () => {
  it("classifies change requests as fix", () => {
    expect(classifyIntent("please fix the selector")).toBe("fix");
    expect(classifyIntent("update the assertion to check the toast")).toBe("fix");
    expect(classifyIntent("this is broken")).toBe("fix");
  });

  it("classifies questions as explain", () => {
    expect(classifyIntent("why did you choose this selector?")).toBe("explain");
    expect(classifyIntent("what does this test cover")).toBe("explain");
  });

  it("classifies pleasantries as acknowledge", () => {
    expect(classifyIntent("thanks")).toBe("acknowledge");
    expect(classifyIntent("lgtm")).toBe("acknowledge");
  });

  it("treats an empty instruction as ignore", () => {
    expect(classifyIntent("   ")).toBe("ignore");
  });

  it("treats a terse directive with no verb as a fix", () => {
    expect(classifyIntent("the login button selector")).toBe("fix");
  });
});

describe("responder markers (loop-safety)", () => {
  it("marks a reply and recognises it as the responder's own", () => {
    const reply = markReply("done", 2);
    expect(reply).toContain(RESPONDER_MARKER);
    expect(isResponderComment(reply)).toBe(true);
    expect(isResponderComment("a human comment")).toBe(false);
  });

  it("reads the highest iteration recorded across comments", () => {
    const bodies = [
      "human comment",
      markReply("first", 1),
      "another human",
      markReply("second", 3),
    ];
    expect(highestIteration(bodies)).toBe(3);
    expect(highestIteration(["no markers here"])).toBe(0);
  });
});
