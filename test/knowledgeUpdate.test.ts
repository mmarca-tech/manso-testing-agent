import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureLearnings, guidelineTargetPath } from "../src/agents/learningEngine/index.js";
import { parseUpdateMention, runKnowledgeUpdate } from "../src/agents/learningEngine/knowledgeUpdate.js";
import type { VcsAdapter, VcsRaisePullRequestResult } from "../src/integrations/vcs/adapter.js";

describe("parseUpdateMention", () => {
  it("detects @update-knowledge as project scope", () => {
    expect(parseUpdateMention("@update-knowledge never use Thread.Sleep here")).toEqual({
      scope: "project",
      handle: "@update-knowledge",
      instruction: "never use Thread.Sleep here",
    });
  });

  it("detects @update-agent as agent scope", () => {
    expect(parseUpdateMention("@update-agent: always prefer getByRole over CSS")).toMatchObject({
      scope: "agent",
      instruction: "always prefer getByRole over CSS",
    });
  });

  it("returns undefined when neither handle is present", () => {
    expect(parseUpdateMention("@manso fix this")).toBeUndefined();
    expect(parseUpdateMention("just a comment")).toBeUndefined();
  });
});

describe("guidelineTargetPath (scope routing)", () => {
  it("routes project scope to .agents/guidelines and agent scope to proposed-guidelines", () => {
    expect(guidelineTargetPath("project", "selector")).toBe(".agents/guidelines/selectors.md");
    expect(guidelineTargetPath("agent", "selector")).toBe("proposed-guidelines/selectors.md");
    expect(guidelineTargetPath("agent", "timing")).toBe("proposed-guidelines/waiting.md");
  });
});

describe("captureLearnings — forced systemic + scope", () => {
  it("forces a systemic record with a scope-routed proposed change", () => {
    const set = captureLearnings({
      scope: "agent",
      signals: [{ source: "pr-feedback", text: "ship it", forceSystemic: true }],
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(set.records[0]?.classification).toBe("systemic");
    expect(set.records[0]?.proposedChange?.targetPath).toBe("proposed-guidelines/general.md");
  });
});

describe("runKnowledgeUpdate", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "manso-ku-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  function fakeAdapter(): VcsAdapter {
    return {
      kind: "azure-devops",
      async raisePullRequest(): Promise<VcsRaisePullRequestResult> {
        return { status: "raised", url: "https://dev.azure.com/pr/1" };
      },
    };
  }

  it("dry-run proposes a project rule to .agents/guidelines and replies", async () => {
    const result = await runKnowledgeUpdate({
      scope: "project",
      instruction: "never use Thread.Sleep; wait for state",
      repoRoot: repo,
      adapter: fakeAdapter(),
      issueKey: "QATG-1",
      dryRun: true,
    });
    expect(result.proposal.status).toBe("dry-run");
    expect(result.proposal.editedFiles).toContain(".agents/guidelines/waiting.md");
    expect(result.reply).toContain("dry-run");
    expect(result.reply).toContain(".agents/guidelines");
  });

  it("dry-run for agent scope targets proposed-guidelines", async () => {
    const result = await runKnowledgeUpdate({
      scope: "agent",
      instruction: "always prefer getByRole over CSS selectors",
      repoRoot: repo,
      adapter: fakeAdapter(),
      dryRun: true,
    });
    expect(result.proposal.editedFiles).toContain("proposed-guidelines/selectors.md");
    expect(result.reply).toContain("Manso's own guidelines");
  });
});
