import { describe, expect, it } from "vitest";
import { summarisePullRequest } from "../src/agents/pullRequestSummariser/index.js";
import type { LlmTextClient, LlmTextGenerationRequest } from "../src/integrations/llm/types.js";
import type { VcsPullRequestDiff } from "../src/integrations/vcs/adapter.js";

function stubLlm(response: string): LlmTextClient {
  return {
    provider: "anthropic",
    model: "stub",
    toolName: "stub:test",
    async generateText(_req: LlmTextGenerationRequest): Promise<string> {
      return response;
    },
  };
}

function stubDiff(): VcsPullRequestDiff {
  return {
    files: [
      { path: "src/auth/login.ts", changeType: "edit", patch: "@@ -1,2 +1,3 @@\n+added line\n" },
      { path: "src/auth/session.ts", changeType: "add" },
    ],
    hasPatches: false,
  };
}

describe("summarisePullRequest", () => {
  it("parses a well-formed LLM response into a PullRequestUnderstanding", async () => {
    const llm = stubLlm(
      JSON.stringify({
        summary: "Adds a session timeout to the login flow.",
        changeAreas: ["authentication", "session management"],
        risks: ["Existing sessions may be invalidated unexpectedly."],
      }),
    );

    const result = await summarisePullRequest({
      pullRequestTitle: "Add session timeout",
      ticketTitle: "Improve login security",
      diff: stubDiff(),
      llm,
    });

    expect(result.summary).toBe("Adds a session timeout to the login flow.");
    expect(result.changeAreas).toEqual(["authentication", "session management"]);
    expect(result.risks).toEqual(["Existing sessions may be invalidated unexpectedly."]);
  });

  it("defaults changeAreas/risks to [] when absent", async () => {
    const llm = stubLlm(JSON.stringify({ summary: "A small fix." }));
    const result = await summarisePullRequest({
      pullRequestTitle: "Small fix",
      ticketTitle: "Ticket",
      diff: stubDiff(),
      llm,
    });
    expect(result.changeAreas).toEqual([]);
    expect(result.risks).toEqual([]);
  });

  it("keeps fetched patches in the prompt when only some files have patches", async () => {
    let userPrompt = "";
    const llm: LlmTextClient = {
      ...stubLlm(JSON.stringify({ summary: "Partial." })),
      async generateText(req: LlmTextGenerationRequest): Promise<string> {
        userPrompt = req.userPrompt;
        return JSON.stringify({ summary: "Partial." });
      },
    };

    await summarisePullRequest({ pullRequestTitle: "Partial", ticketTitle: "Ticket", diff: stubDiff(), llm });

    expect(userPrompt).toContain("(partial patches)");
    expect(userPrompt).toContain("+added line");
    expect(userPrompt).toContain("- src/auth/session.ts (add; patch unavailable)");
  });

  it("throws when the LLM response is not a JSON object", async () => {
    const llm = stubLlm("not json at all");
    await expect(
      summarisePullRequest({
        pullRequestTitle: "Bad response",
        ticketTitle: "Ticket",
        diff: stubDiff(),
        llm,
      }),
    ).rejects.toThrow();
  });

  it("throws when 'summary' is missing or empty", async () => {
    const llm = stubLlm(JSON.stringify({ changeAreas: [], risks: [] }));
    await expect(
      summarisePullRequest({
        pullRequestTitle: "Missing summary",
        ticketTitle: "Ticket",
        diff: stubDiff(),
        llm,
      }),
    ).rejects.toThrow(/summary/);
  });
});
