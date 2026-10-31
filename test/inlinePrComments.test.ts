import { describe, expect, it, vi } from "vitest";
import { AzureDevOpsAdapter } from "../src/integrations/vcs/azureDevOpsAdapter.js";
import { GitHubAdapter } from "../src/integrations/vcs/githubAdapter.js";
import { patchContainsLine } from "../src/integrations/vcs/diffLocation.js";
import type { VcsInlineCommentLocation } from "../src/integrations/vcs/adapter.js";

const head = "b".repeat(40);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const location = (side: "left" | "right" = "right"): VcsInlineCommentLocation => ({
  path: "src/file.ts", line: 12, side, sourceCommit: head,
});
const azure = (fetchFn: typeof fetch) => new AzureDevOpsAdapter({
  organization: "org", project: "project", repository: "repo", pat: "pat", fetchFn,
});
const github = (fetchFn: typeof fetch) => new GitHubAdapter({ owner: "org", repo: "repo", token: "token", fetchFn });

describe("Azure inline PR threads", () => {
  it.each(["left", "right"] as const)("posts the exact %s file line in the reviewed iteration", async (side) => {
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/iterations")) return json({ value: [
        { id: 3, sourceRefCommit: { commitId: head } }, { id: 1, sourceRefCommit: { commitId: "a".repeat(40) } },
      ] });
      if (url.pathname.endsWith("/iterations/3/changes")) {
        expect(url.searchParams.get("$compareTo")).toBe("0");
        return json({ changeEntries: [{ changeTrackingId: 9, item: { path: "/src/file.ts" } }], nextSkip: 0 });
      }
      expect(url.pathname).toBe("/org/project/_apis/git/repositories/repo/pullRequests/42/threads");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.comments).toEqual([{ parentCommentId: 0, content: "Finding", commentType: "text" }]);
      expect(body.status).toBe("active");
      expect(body.threadContext).toEqual({
        filePath: "/src/file.ts",
        [`${side}FileStart`]: { line: 12, offset: 1 },
        [`${side}FileEnd`]: { line: 12, offset: 1 },
      });
      expect(body.pullRequestThreadContext).toEqual({
        changeTrackingId: 9, iterationContext: { firstComparingIteration: 0, secondComparingIteration: 3 },
      });
      return json({ id: 55 });
    });
    const result = await azure(fetchFn).postPullRequestComment({ pullRequestId: 42, content: "Finding", inline: location(side) });
    expect(result).toEqual({ status: "posted", threadId: 55 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("accepts Azure-style paths and handles files on later change pages", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/iterations")) return json({ value: [{ id: 2, sourceRefCommit: { commitId: head } }] });
      if (url.pathname.endsWith("/changes")) {
        const skip = Number(url.searchParams.get("$skip"));
        return json({
          changeEntries: [{ changeTrackingId: 7, item: { path: skip === 0 ? "/other.ts" : "/src/file.ts" } }],
          nextSkip: skip === 0 ? 100 : 0,
        });
      }
      expect(JSON.parse(String(init?.body)).threadContext.filePath).toBe("/src/file.ts");
      return json({ id: 1 });
    });
    const result = await azure(fetchFn).postPullRequestComment({
      pullRequestId: 42, content: "Finding", inline: { ...location(), path: "/src/file.ts" },
    });
    expect(result.status).toBe("posted");
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("rejects a stale source commit without posting", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({ value: [{ id: 2, sourceRefCommit: { commitId: "a".repeat(40) } }] }));
    const result = await azure(fetchFn).postPullRequestComment({ pullRequestId: 42, content: "Finding", inline: location() });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("no longer matches");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("refuses an untracked path rather than posting to the wrong file", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => String(input).includes("/changes")
      ? json({ changeEntries: [{ changeTrackingId: 1, item: { path: "/other.ts" } }], nextSkip: 0 })
      : json({ value: [{ id: 1, sourceRefCommit: { commitId: head } }] }));
    const result = await azure(fetchFn).postPullRequestComment({ pullRequestId: 42, content: "Finding", inline: location() });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("no tracked diff file");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("surfaces a failed inline POST explicitly", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/changes")) return json({ changeEntries: [{ changeTrackingId: 1, item: { path: "/src/file.ts" } }], nextSkip: 0 });
      if (url.includes("/iterations")) return json({ value: [{ id: 1, sourceRefCommit: { commitId: head } }] });
      return json({ message: "forbidden" }, 403);
    });
    expect((await azure(fetchFn).postPullRequestComment({ pullRequestId: 42, content: "Finding", inline: location() })).status).toBe("failed");
  });

  it("preserves top-level summary requests without inline metadata", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.threadContext).toBeUndefined();
      expect(body.pullRequestThreadContext).toBeUndefined();
      return json({ id: 1 });
    });
    expect((await azure(fetchFn).postPullRequestComment({ pullRequestId: 42, content: "Summary" })).status).toBe("posted");
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});

describe("GitHub inline PR review comments", () => {
  it.each(["left", "right"] as const)("uses absolute file line and %s side, not an obsolete diff position", async (side) => {
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://api.github.com/repos/org/repo/pulls/42/comments");
      expect(JSON.parse(String(init?.body))).toEqual({
        body: "Finding", commit_id: head, path: "src/file.ts", line: 12, side: side.toUpperCase(),
      });
      return json({ id: 99 }, 201);
    });
    const result = await github(fetchFn).postPullRequestComment({
      pullRequestId: 42, content: "Finding", inline: { ...location(side), path: "/src/file.ts" },
    });
    expect(result).toEqual({ status: "posted", commentId: 99 });
  });

  it("preserves the Enterprise API prefix for both inline and summary comments", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      expect(new URL(String(input)).pathname).toMatch(/^\/api\/v3\/repos\/org\/repo\/(?:pulls|issues)\/42\/comments$/);
      return json({ id: 1 }, 201);
    });
    const adapter = new GitHubAdapter({ owner: "org", repo: "repo", token: "token", apiBaseUrl: "https://enterprise.test/api/v3", fetchFn });
    await adapter.postPullRequestComment({ pullRequestId: 42, content: "Finding", inline: location() });
    await adapter.postPullRequestComment({ pullRequestId: 42, content: "Summary" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("surfaces line-validation rejection without converting to a top-level comment", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({ message: "line is not part of the diff" }, 422));
    const result = await github(fetchFn).postPullRequestComment({ pullRequestId: 42, content: "Finding", inline: location() });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("422");
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});

describe.each(["azure", "github"] as const)("%s inline mutation guards", (kind) => {
  const adapter = (fetchFn: typeof fetch) => kind === "azure" ? azure(fetchFn) : github(fetchFn);
  it("does not make any API calls in dry-run", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    expect((await adapter(fetchFn).postPullRequestComment({
      pullRequestId: 42, content: "Finding", inline: location(), dryRun: true,
    })).status).toBe("dry-run");
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("rejects conflicting inline and reply coordinates", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    expect((await adapter(fetchFn).postPullRequestComment({
      pullRequestId: 42, content: "Finding", inline: location(), threadId: 1,
    })).status).toBe("failed");
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5])("rejects an invalid line %s before the API", async (line) => {
    const fetchFn = vi.fn<typeof fetch>();
    expect((await adapter(fetchFn).postPullRequestComment({
      pullRequestId: 42, content: "Finding", inline: { ...location(), line },
    })).status).toBe("failed");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("exact diff-line validation", () => {
  const patch = "@@ -10,3 +20,3 @@\n context\n-removed\n+added\n context2\n@@ -50 +60 @@\n-old\n+new";
  it.each([
    [10, "left", true], [11, "left", true], [12, "left", true], [13, "left", false],
    [20, "right", true], [21, "right", true], [22, "right", true], [23, "right", false],
    [50, "left", true], [60, "right", true], [11, "right", false], [21, "left", false],
  ] as const)("anchors line %s on %s: %s", (line, side, expected) => {
    expect(patchContainsLine(patch, line, side)).toBe(expected);
  });
  it("rejects a hunk-header line whose text was omitted by truncation", () => {
    expect(patchContainsLine("@@ -1,5 +1,5 @@\n context", 5)).toBe(false);
    expect(patchContainsLine("@@ -1,5 +1,5 @@\n context", 1)).toBe(true);
  });
  it("supports additions/deletions and no-newline markers", () => {
    expect(patchContainsLine("@@ -0,0 +1 @@\n+new\n\\ No newline at end of file", 1)).toBe(true);
    expect(patchContainsLine("@@ -1 +0,0 @@\n-old\n\\ No newline at end of file", 1, "left")).toBe(true);
    expect(patchContainsLine("@@ -1 +0,0 @@\n-old", 1)).toBe(false);
  });
});
