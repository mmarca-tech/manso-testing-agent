import { describe, expect, it, vi } from "vitest";
import { AzureDevOpsAdapter } from "../src/integrations/vcs/azureDevOpsAdapter.js";
import { GitHubAdapter } from "../src/integrations/vcs/githubAdapter.js";

const base = "a".repeat(40);
const head = "b".repeat(40);
const common = "c".repeat(40);
const azurePr = {
  pullRequestId: 1, title: "ABC-1", description: "Review", sourceRefName: "refs/heads/ABC-1", targetRefName: "refs/heads/main",
  lastMergeSourceCommit: { commitId: head }, lastMergeTargetCommit: { commitId: base },
};
const githubPr = {
  number: 1, title: "ABC-1", body: null, html_url: "https://example.test/pr/1",
  head: { ref: "ABC-1", sha: head }, base: { ref: "main", sha: base }, changed_files: 1,
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const azure = (fetchFn: typeof fetch) => new AzureDevOpsAdapter({ organization: "org", project: "project", repository: "repo", pat: "pat", fetchFn });
const github = (fetchFn: typeof fetch) => new GitHubAdapter({ owner: "org", repo: "repo", token: "token", fetchFn });

describe("Azure proactive PR evidence", () => {
  it("reads metadata and compares merge-base to source, using commit-pinned old and new content", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/pullrequests/1")) return json(azurePr);
      if (url.pathname.endsWith("/diffs/commits")) {
        expect(url.searchParams.get("baseVersion")).toBe(base);
        expect(url.searchParams.get("targetVersion")).toBe(head);
        expect(url.searchParams.get("diffCommonCommit")).toBe("true");
        return json({ commonCommit: common, allChangesIncluded: true, changes: [
          { changeType: "edit", item: { path: "/file.ts", gitObjectType: "blob" } },
        ] });
      }
      expect(url.searchParams.get("path")).toBe("/file.ts");
      const commit = url.searchParams.get("versionDescriptor.version");
      expect([common, head]).toContain(commit);
      return new Response(commit === common ? "old\n" : "new\n");
    });
    const adapter = azure(fetchFn);
    expect((await adapter.getPullRequest(1)).sourceCommit).toBe(head);
    const diff = await adapter.getPullRequestDiff(1);
    expect(diff.hasPatches).toBe(true);
    expect(diff.allChangesIncluded).toBe(true);
    expect(diff.files[0]?.patch).toContain("-old");
    expect(diff.files[0]?.patch).toContain("+new");
  });

  it.each(["add", "delete", "rename"])("handles %s without treating a failed read as an empty side", async (type) => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/pullrequests/1")) return json(azurePr);
      if (url.pathname.endsWith("/diffs/commits")) return json({
        commonCommit: common, allChangesIncluded: true,
        changes: [{ changeType: type, sourceServerItem: "/old.ts", item: { path: "/new.ts", gitObjectType: "blob" } }],
      });
      if (type === "rename" && url.searchParams.get("versionDescriptor.version") === common) {
        expect(url.searchParams.get("path")).toBe("/old.ts");
      }
      return new Response("content\n");
    });
    const diff = await azure(fetchFn).getPullRequestDiff(1);
    expect(diff.files[0]?.changeType).toBe(type);
    expect(diff.hasPatches).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(type === "rename" ? 4 : 3);
  });

  it("paginates changed files rather than silently reading only the first page", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/pullrequests/1")) return json(azurePr);
      if (url.pathname.endsWith("/diffs/commits")) {
        const skip = Number(url.searchParams.get("$skip"));
        return json({
          commonCommit: common, allChangesIncluded: skip === 100,
          changes: [{ changeType: "add", item: { path: `/${skip}.ts`, gitObjectType: "blob" } }],
        });
      }
      return new Response("content\n");
    });
    expect((await azure(fetchFn).getPullRequestDiff(1)).files.map((file) => file.path)).toEqual(["/0.ts", "/100.ts"]);
  });

  it("reports binary and oversized files as incomplete, never fabricated patches", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/pullrequests/1")) return json(azurePr);
      if (url.pathname.endsWith("/diffs/commits")) return json({
        commonCommit: common, allChangesIncluded: true,
        changes: [{ changeType: "edit", item: { path: "/file", gitObjectType: "blob" } }],
      });
      return new Response(url.searchParams.get("versionDescriptor.version") === common ? "\0" : "x".repeat(200_001));
    });
    const diff = await azure(fetchFn).getPullRequestDiff(1);
    expect(diff.hasPatches).toBe(false);
    expect(diff.files[0]?.patch).toBeUndefined();
    expect(diff.warnings).toHaveLength(2);
  });

  it("propagates failed blob reads instead of inventing additions or deletions", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/pullrequests/1")) return json(azurePr);
      if (url.pathname.endsWith("/diffs/commits")) return json({
        commonCommit: common, allChangesIncluded: true,
        changes: [{ changeType: "edit", item: { path: "/file", gitObjectType: "blob" } }],
      });
      return new Response("Forbidden", { status: 403 });
    });
    await expect(azure(fetchFn).getPullRequestDiff(1)).rejects.toThrow("403");
  });

  it("requires valid commit metadata instead of silently producing an empty review", async () => {
    await expect(azure(async () => json({ ...azurePr, lastMergeSourceCommit: undefined })).getPullRequestDiff(1)).rejects.toThrow();
  });

  it("exposes submodule changes as missing evidence instead of silently excluding them", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("/pullrequests/1")) return json(azurePr);
      return json({
        commonCommit: common, allChangesIncluded: true,
        changes: [{ changeType: "edit", item: { path: "/submodule", gitObjectType: "commit" } }],
      });
    });
    const diff = await azure(fetchFn).getPullRequestDiff(1);
    expect(diff.files).toEqual([{ path: "/submodule", changeType: "edit" }]);
    expect(diff.hasPatches).toBe(false);
    expect(diff.warnings?.join(" ")).toContain("non-text Git object");
  });
});

describe("GitHub proactive PR evidence", () => {
  it("reads metadata and patches while retaining enterprise API prefixes", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toContain("/api/v3/repos/org/repo/pulls/1");
      if (!url.pathname.endsWith("/files")) return json(githubPr);
      return json([{ filename: "file.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }]);
    });
    const adapter = new GitHubAdapter({ owner: "org", repo: "repo", token: "token", apiBaseUrl: "https://enterprise.test/api/v3", fetchFn });
    expect((await adapter.getPullRequest(1)).sourceBranch).toBe("ABC-1");
    expect((await adapter.getPullRequestDiff(1)).hasPatches).toBe(true);
  });

  it("paginates all files", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/files")) return json({ ...githubPr, changed_files: 101 });
      const page = Number(url.searchParams.get("page"));
      return json(Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => ({ filename: `${page}-${i}.ts`, status: "added", patch: "@@ -0,0 +1 @@\n+new" })));
    });
    const diff = await github(fetchFn).getPullRequestDiff(1);
    expect(diff.files).toHaveLength(101);
    expect(diff.allChangesIncluded).toBe(true);
  });

  it("reports missing patches and a prematurely ended file list", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/files")) return json({ ...githubPr, changed_files: 2 });
      return json(url.searchParams.get("page") === "1" ? [{ filename: "binary.png", status: "added" }] : []);
    });
    const diff = await github(fetchFn).getPullRequestDiff(1);
    expect(diff.hasPatches).toBe(false);
    expect(diff.allChangesIncluded).toBe(false);
    expect(diff.warnings?.join(" ")).toContain("Only 1 of 2");
  });

  it("surfaces HTTP errors", async () => {
    await expect(github(async () => json({}, 401)).getPullRequest(1)).rejects.toThrow("401");
  });
});
