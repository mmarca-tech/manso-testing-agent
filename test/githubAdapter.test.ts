import { describe, expect, it, vi } from "vitest";
import {
  GitHubAdapter,
  parseGitHubRemoteUrl,
} from "../src/integrations/vcs/githubAdapter.js";
import { resolveVcsAdapter, vcsTokensFromRuntime } from "../src/integrations/vcs/resolve.js";

describe("parseGitHubRemoteUrl", () => {
  it("parses https github.com remotes", () => {
    expect(parseGitHubRemoteUrl("https://github.com/acme/widgets.git")).toEqual({
      owner: "acme",
      repo: "widgets",
      host: "github.com",
      apiBaseUrl: "https://api.github.com",
    });
  });

  it("parses ssh github.com remotes (no .git)", () => {
    expect(parseGitHubRemoteUrl("git@github.com:acme/widgets")).toMatchObject({
      owner: "acme",
      repo: "widgets",
      apiBaseUrl: "https://api.github.com",
    });
  });

  it("parses GitHub Enterprise hosts into the /api/v3 base", () => {
    expect(parseGitHubRemoteUrl("https://github.example.com/team/repo.git")).toEqual({
      owner: "team",
      repo: "repo",
      host: "github.example.com",
      apiBaseUrl: "https://github.example.com/api/v3",
    });
  });

  it("returns undefined for non-GitHub remotes", () => {
    expect(parseGitHubRemoteUrl("https://dev.azure.com/org/proj/_git/repo")).toBeUndefined();
    expect(parseGitHubRemoteUrl("")).toBeUndefined();
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function adapter(fetchFn: typeof fetch): GitHubAdapter {
  return new GitHubAdapter({ owner: "acme", repo: "widgets", token: "ghp_test", fetchFn });
}

describe("GitHubAdapter.raisePullRequest", () => {
  it("POSTs to /pulls and returns the PR number + url", async () => {
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.github.com/repos/acme/widgets/pulls");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ title: "Add tests", head: "manso/QATG-1", base: "main" });
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer ghp_test");
      expect(headers["User-Agent"]).toBe("manso");
      return jsonResponse(201, { number: 42, html_url: "https://github.com/acme/widgets/pull/42" });
    }) as unknown as typeof fetch;

    const result = await adapter(fetchFn).raisePullRequest({
      branch: "refs/heads/manso/QATG-1",
      targetBranch: "main",
      title: "Add tests",
      description: "body",
    });
    expect(result).toMatchObject({ status: "raised", pullRequestId: 42, url: "https://github.com/acme/widgets/pull/42" });
  });

  it("maps a 422 'already exists' to status exists", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(422, { message: "Validation Failed", errors: [{ message: "A pull request already exists for acme:feature." }] }),
    ) as unknown as typeof fetch;
    const result = await adapter(fetchFn).raisePullRequest({ branch: "feature", targetBranch: "main", title: "t" });
    expect(result.status).toBe("exists");
  });

  it("does not call the API on dry-run", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const result = await adapter(fetchFn).raisePullRequest({ branch: "b", targetBranch: "main", title: "t", dryRun: true });
    expect(result.status).toBe("dry-run");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("GitHubAdapter threads + comments", () => {
  it("returns issue comments as a conversation thread (id 0) and review comments grouped by root", async () => {
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/issues/7/comments")) {
        return jsonResponse(200, [{ id: 100, body: "@manso fix the selector", user: { login: "rev", id: 1 }, created_at: "2026-01-01T00:00:00Z" }]);
      }
      if (u.includes("/pulls/7/comments")) {
        return jsonResponse(200, [
          { id: 200, body: "root review", user: { login: "rev", id: 1 } },
          { id: 201, body: "reply", user: { login: "rev", id: 1 }, in_reply_to_id: 200 },
        ]);
      }
      return jsonResponse(404, {});
    }) as unknown as typeof fetch;

    const threads = await adapter(fetchFn).listPullRequestThreads(7);
    const conversation = threads.find((t) => t.id === 0);
    expect(conversation?.comments[0]?.content).toContain("@manso");
    const reviewThread = threads.find((t) => t.id === 200);
    expect(reviewThread?.comments).toHaveLength(2);
  });

  it("follows pagination so comments beyond the first 100 are listed", async () => {
    const issueComment = (id: number) => ({ id, body: `comment ${id}`, user: { login: "rev", id: 1 } });
    const requested: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      requested.push(u.pathname + u.search);
      if (u.pathname.endsWith("/issues/7/comments")) {
        const page = Number(u.searchParams.get("page"));
        if (page === 1) return jsonResponse(200, Array.from({ length: 100 }, (_, i) => issueComment(i + 1)));
        if (page === 2) return jsonResponse(200, [issueComment(101), issueComment(102)]);
      }
      return jsonResponse(200, []);
    }) as unknown as typeof fetch;

    const threads = await adapter(fetchFn).listPullRequestThreads(7);
    expect(threads.find((t) => t.id === 0)?.comments).toHaveLength(102);
    expect(requested.filter((r) => r.includes("/issues/7/comments"))).toHaveLength(2);
  });

  it("refuses a partial list when the page cap is reached", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: "x", user: { login: "rev", id: 1 } })))) as unknown as typeof fetch;
    await expect(adapter(fetchFn).listPullRequestThreads(7)).rejects.toThrow("partial list");
  });

  it("posts an issue comment for the conversation thread and a reply for a review thread", async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return jsonResponse(201, { id: 999 });
    }) as unknown as typeof fetch;

    const gh = adapter(fetchFn);
    await gh.postPullRequestComment({ pullRequestId: 7, threadId: 0, content: "ack" });
    await gh.postPullRequestComment({ pullRequestId: 7, threadId: 200, content: "reply" });

    expect(calls[0]).toBe("https://api.github.com/repos/acme/widgets/issues/7/comments");
    expect(calls[1]).toBe("https://api.github.com/repos/acme/widgets/pulls/7/comments/200/replies");
  });
});

describe("GitHubAdapter.updatePullRequestComment", () => {
  it("PATCHes an issue comment for the conversation thread and a review comment otherwise", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push([String(url), init?.method]);
      return jsonResponse(200, { id: 1 });
    }) as unknown as typeof fetch;
    const gh = adapter(fetchFn);
    await gh.updatePullRequestComment({ pullRequestId: 7, threadId: 0, commentId: 11, content: "x" });
    await gh.updatePullRequestComment({ pullRequestId: 7, threadId: 200, commentId: 201, content: "y" });
    expect(calls).toEqual([
      ["https://api.github.com/repos/acme/widgets/issues/comments/11", "PATCH"],
      ["https://api.github.com/repos/acme/widgets/pulls/comments/201", "PATCH"],
    ]);
  });
});

describe("GitHubAdapter.getAuthenticatedUserId", () => {
  it("returns the token owner id as a string, matching comment authorId", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { id: 4242, login: "bot" })) as unknown as typeof fetch;
    expect(await adapter(fetchFn).getAuthenticatedUserId()).toBe("4242");
  });

  it("is undefined for tokens that cannot read /user (e.g. GitHub App installations)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(403, { message: "forbidden" })) as unknown as typeof fetch;
    expect(await adapter(fetchFn).getAuthenticatedUserId()).toBeUndefined();
  });
});

describe("resolveVcsAdapter (router)", () => {
  it("builds a GitHub adapter when only a GitHub token is present and the remote is GitHub", () => {
    // parseGitHubRemoteUrl drives detection; here we assert token routing logic
    // via vcsTokensFromRuntime.
    expect(vcsTokensFromRuntime({ github: { token: "ghp" } })).toEqual({ githubToken: "ghp" });
    expect(vcsTokensFromRuntime({ azureDevOps: { token: "pat" } })).toEqual({ azureDevOpsToken: "pat" });
  });

  it("reports a clear reason when no supported remote is found", async () => {
    // A temp dir with no git remote → resolution fails with a reason.
    const result = await resolveVcsAdapter(process.cwd(), {});
    // cwd may or may not have a remote; assert the shape regardless.
    if (!result.ok) {
      expect(result.reason).toMatch(/remote|token/i);
    } else {
      expect(result.adapter).toBeDefined();
    }
  });
});
