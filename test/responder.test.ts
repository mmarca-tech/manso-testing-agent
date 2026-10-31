import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRespondToPr } from "../src/agents/responder/index.js";
import { markReply } from "../src/agents/responder/mention.js";
import type { CommandResult } from "../src/domain/implementationPack/schema.js";
import type {
  ImplementationAgentRunInput,
  ImplementationAgentRunner,
} from "../src/integrations/llm/agentRunner.js";
import type {
  VcsAdapter,
  VcsCommentThread,
  VcsPostCommentInput,
  VcsPostCommentResult,
  VcsRaisePullRequestInput,
  VcsRaisePullRequestResult,
} from "../src/integrations/vcs/adapter.js";

interface Posted {
  threadId?: number;
  content: string;
}

class FakeAdapter implements VcsAdapter {
  readonly kind = "azure-devops" as const;
  readonly posted: Posted[] = [];
  constructor(private readonly threads: VcsCommentThread[]) {}

  async raisePullRequest(_input: VcsRaisePullRequestInput): Promise<VcsRaisePullRequestResult> {
    return { status: "raised" };
  }
  async listPullRequestThreads(_id: number): Promise<VcsCommentThread[]> {
    return this.threads;
  }
  async postPullRequestComment(input: VcsPostCommentInput): Promise<VcsPostCommentResult> {
    this.posted.push({ ...(input.threadId !== undefined ? { threadId: input.threadId } : {}), content: input.content });
    return { status: "posted", threadId: input.threadId ?? 999, commentId: 1 };
  }
}

function humanThread(id: number, content: string, author = "Reviewer"): VcsCommentThread {
  return { id, status: "active", comments: [{ id: id * 10, content, author }] };
}

function stubRunner(impl?: (input: ImplementationAgentRunInput) => CommandResult): ImplementationAgentRunner {
  return {
    kind: "shell",
    commandLabel: "stub-agent",
    provider: "anthropic",
    model: "stub",
    run: async (input) => impl?.(input) ?? { command: "stub-agent", exitCode: 0, durationMs: 1 },
  };
}

describe("runRespondToPr", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "manso-responder-"));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  const baseInput = (adapter: FakeAdapter, extra: Partial<Parameters<typeof runRespondToPr>[0]> = {}) => ({
    issueKey: "QATG-1",
    repoRoot,
    pullRequestId: 7,
    adapter,
    runner: stubRunner(),
    verifyCommand: `node -e "process.exit(0)"`,
    ...extra,
  });

  it("applies a feedback-scoped fix and replies with the verify result", async () => {
    let received: ImplementationAgentRunInput | undefined;
    const adapter = new FakeAdapter([humanThread(1, "@manso please fix the login selector")]);
    const result = await runRespondToPr(
      baseInput(adapter, { runner: stubRunner((i) => { received = i; return { command: "stub-agent", exitCode: 0, durationMs: 1 }; }) }),
    );

    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.action).toBe("fixed");
    expect(result.threads[0]?.intent).toBe("fix");
    expect(received?.prompt).toContain("please fix the login selector");
    expect(received?.phase).toBe("healing");
    // A marked reply was posted in the thread.
    expect(adapter.posted[0]?.threadId).toBe(1);
    expect(adapter.posted[0]?.content).toContain("manso-bot:iteration:1");
  });

  it("replies (no agent run) for explain and acknowledge intents", async () => {
    const adapter = new FakeAdapter([
      humanThread(1, "@manso why this selector?"),
      humanThread(2, "@manso thanks"),
    ]);
    let agentRuns = 0;
    const result = await runRespondToPr(baseInput(adapter, { runner: stubRunner(() => { agentRuns += 1; return { command: "x", exitCode: 0, durationMs: 1 }; }) }));

    expect(agentRuns).toBe(0);
    expect(result.threads.map((t) => t.intent)).toEqual(["explain", "acknowledge"]);
    expect(result.threads.every((t) => t.action === "replied")).toBe(true);
    expect(adapter.posted).toHaveLength(2);
  });

  it("skips a thread the responder already answered last (loop-safety)", async () => {
    const adapter = new FakeAdapter([
      {
        id: 1,
        status: "active",
        comments: [
          { id: 11, content: "@manso fix the assertion", author: "Reviewer" },
          { id: 12, content: markReply("Done — verification passed.", 1) },
        ],
      },
    ]);
    const result = await runRespondToPr(baseInput(adapter));
    expect(result.threads).toHaveLength(0);
    expect(adapter.posted).toHaveLength(0);
  });

  it("stops when the PR iteration budget is already reached", async () => {
    const adapter = new FakeAdapter([
      { id: 1, status: "active", comments: [{ id: 11, content: markReply("prior", 5) }] },
      humanThread(2, "@manso fix it"),
    ]);
    const result = await runRespondToPr(baseInput(adapter, { maxIterations: 5 }));
    expect(result.threads).toHaveLength(0);
    expect(result.warnings.some((w) => /budget reached/i.test(w))).toBe(true);
  });

  it("ignores threads that do not mention the handle", async () => {
    const adapter = new FakeAdapter([humanThread(1, "looks good, merging soon")]);
    const result = await runRespondToPr(baseInput(adapter));
    expect(result.threads).toHaveLength(0);
    expect(adapter.posted).toHaveLength(0);
  });

  it("dry-run classifies but does not run the agent or post", async () => {
    let agentRuns = 0;
    const adapter = new FakeAdapter([humanThread(1, "@manso fix the selector")]);
    const result = await runRespondToPr(baseInput(adapter, { dryRun: true, runner: stubRunner(() => { agentRuns += 1; return { command: "x", exitCode: 0, durationMs: 1 }; }) }));
    expect(agentRuns).toBe(0);
    expect(adapter.posted).toHaveLength(0);
    expect(result.threads[0]?.action).toBe("skipped");
    expect(result.threads[0]?.intent).toBe("fix");
  });

  it("reports a warning when the adapter cannot read threads", async () => {
    const adapter = { kind: "github" as const, raisePullRequest: async () => ({ status: "raised" as const }) };
    const result = await runRespondToPr(baseInput(adapter as unknown as FakeAdapter));
    expect(result.threads).toHaveLength(0);
    expect(result.warnings.some((w) => /does not support/i.test(w))).toBe(true);
  });

  it("handles @update-knowledge as a project rule proposal (dry-run, no agent run)", async () => {
    let agentRuns = 0;
    const adapter = new FakeAdapter([humanThread(1, "@update-knowledge never use Thread.Sleep")]);
    const result = await runRespondToPr(
      baseInput(adapter, { dryRun: true, runner: stubRunner(() => { agentRuns += 1; return { command: "x", exitCode: 0, durationMs: 1 }; }) }),
    );
    expect(agentRuns).toBe(0);
    expect(result.threads[0]?.intent).toBe("update-knowledge");
    // dry-run → no post, but it is recorded as handled.
    expect(result.threads[0]?.action).toBe("skipped");
    expect(result.threads[0]?.reply).toContain("dry-run");
  });

  it("refuses @update-agent when the agent repo is not configured", async () => {
    const adapter = new FakeAdapter([humanThread(1, "@update-agent always prefer getByRole")]);
    const result = await runRespondToPr(baseInput(adapter)); // no agentRepoRoot/agentAdapter
    expect(result.threads[0]?.intent).toBe("update-agent");
    expect(result.threads[0]?.action).toBe("skipped");
    expect(result.threads[0]?.reason).toMatch(/MANSO_AGENT_REPO/);
    expect(adapter.posted[0]?.content).toContain("agent repo isn't configured");
  });
});
