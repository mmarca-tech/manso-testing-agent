import { describe, expect, it, vi } from "vitest";
import {
  AzureDevOpsAdapter,
  parseAzureDevOpsRemoteUrl,
} from "../src/integrations/vcs/azureDevOpsAdapter.js";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseAzureDevOpsRemoteUrl", () => {
  it("parses the standard https form", () => {
    const remote = parseAzureDevOpsRemoteUrl(
      "https://dev.azure.com/contoso/payments/_git/checkout",
    );
    expect(remote).toEqual({
      organization: "contoso",
      project: "payments",
      repository: "checkout",
      baseUrl: "https://dev.azure.com",
    });
  });

  it("parses the user-prefixed https form and strips .git", () => {
    const remote = parseAzureDevOpsRemoteUrl(
      "https://contoso@dev.azure.com/contoso/payments/_git/checkout.git",
    );
    expect(remote?.repository).toBe("checkout");
  });

  it("parses the legacy visualstudio.com form", () => {
    const remote = parseAzureDevOpsRemoteUrl(
      "https://contoso.visualstudio.com/payments/_git/checkout",
    );
    expect(remote).toEqual({
      organization: "contoso",
      project: "payments",
      repository: "checkout",
      baseUrl: "https://contoso.visualstudio.com",
    });
  });

  it("parses the SSH form", () => {
    const remote = parseAzureDevOpsRemoteUrl(
      "git@ssh.dev.azure.com:v3/contoso/payments/checkout",
    );
    expect(remote?.organization).toBe("contoso");
    expect(remote?.repository).toBe("checkout");
  });

  it("returns undefined for non-Azure URLs", () => {
    expect(parseAzureDevOpsRemoteUrl("https://github.com/foo/bar.git")).toBeUndefined();
    expect(parseAzureDevOpsRemoteUrl("")).toBeUndefined();
  });
});

describe("AzureDevOpsAdapter.raisePullRequest", () => {
  const ADAPTER_BASE = {
    organization: "contoso",
    project: "payments",
    repository: "checkout",
    pat: "test-pat",
  };

  it("POSTs the right URL with Basic auth and returns raised + url", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      expect(url.toString()).toContain(
        "https://dev.azure.com/contoso/payments/_apis/git/repositories/checkout/pullrequests",
      );
      expect(url.toString()).toContain("api-version=");
      const headers = init?.headers as Record<string, string> | undefined;
      const expectedAuth = `Basic ${Buffer.from(":test-pat", "utf8").toString("base64")}`;
      expect(headers?.Authorization).toBe(expectedAuth);

      const body = init?.body ? JSON.parse(String(init.body)) : {};
      expect(body.sourceRefName).toBe("refs/heads/manso/abc-1");
      expect(body.targetRefName).toBe("refs/heads/main");
      expect(body.title).toBe("Manso: implement ABC-1");

      return mockResponse(
        {
          pullRequestId: 4242,
          _links: {
            web: {
              href: "https://dev.azure.com/contoso/payments/_git/checkout/pullrequest/4242",
            },
          },
        },
        201,
      );
    });

    const adapter = new AzureDevOpsAdapter({ ...ADAPTER_BASE, fetchFn });
    const result = await adapter.raisePullRequest({
      branch: "manso/abc-1",
      targetBranch: "main",
      title: "Manso: implement ABC-1",
    });

    expect(result.status).toBe("raised");
    expect(result.url).toBe(
      "https://dev.azure.com/contoso/payments/_git/checkout/pullrequest/4242",
    );
    expect(result.pullRequestId).toBe(4242);
  });

  it("treats 409 Conflict as status: 'exists'", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      mockResponse({ message: "An active pull request for the source and target branch already exists." }, 409),
    );
    const adapter = new AzureDevOpsAdapter({ ...ADAPTER_BASE, fetchFn });

    const result = await adapter.raisePullRequest({
      branch: "manso/abc-1",
      targetBranch: "main",
      title: "t",
    });
    expect(result.status).toBe("exists");
    expect(result.message).toContain("already exists");
  });

  it("returns 'failed' on other 4xx errors", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      mockResponse({ message: "Unauthorized" }, 401),
    );
    const adapter = new AzureDevOpsAdapter({ ...ADAPTER_BASE, fetchFn });

    const result = await adapter.raisePullRequest({
      branch: "x",
      targetBranch: "main",
      title: "t",
    });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("401");
  });

  it("does not call fetch on dryRun and returns 'dry-run'", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => mockResponse({}));
    const adapter = new AzureDevOpsAdapter({ ...ADAPTER_BASE, fetchFn });

    const result = await adapter.raisePullRequest({
      branch: "x",
      targetBranch: "main",
      title: "t",
      dryRun: true,
    });
    expect(result.status).toBe("dry-run");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("falls back to constructing a web URL when _links is absent", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      mockResponse({ pullRequestId: 7 }, 201),
    );
    const adapter = new AzureDevOpsAdapter({ ...ADAPTER_BASE, fetchFn });

    const result = await adapter.raisePullRequest({
      branch: "x",
      targetBranch: "main",
      title: "t",
    });
    expect(result.url).toBe(
      "https://dev.azure.com/contoso/payments/_git/checkout/pullrequest/7",
    );
  });
});

describe("AzureDevOpsAdapter.updatePullRequestComment", () => {
  const ADAPTER_BASE = { organization: "contoso", project: "payments", repository: "checkout", pat: "test-pat" };

  it("PATCHes the existing comment in its thread", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => mockResponse({ id: 3 }));
    const adapter = new AzureDevOpsAdapter({ ...ADAPTER_BASE, fetchFn });
    const result = await adapter.updatePullRequestComment({ pullRequestId: 9, threadId: 5, commentId: 3, content: "new body" });
    expect(result).toEqual({ status: "posted", threadId: 5, commentId: 3 });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toContain("/pullRequests/9/threads/5/comments/3");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ content: "new body" });
  });

  it("reports a failed update instead of throwing", async () => {
    const adapter = new AzureDevOpsAdapter({ ...ADAPTER_BASE, fetchFn: vi.fn<typeof fetch>(async () => mockResponse({ message: "no" }, 403)) });
    const result = await adapter.updatePullRequestComment({ pullRequestId: 9, threadId: 5, commentId: 3, content: "x" });
    expect(result.status).toBe("failed");
  });
});

describe("AzureDevOpsAdapter.getAuthenticatedUserId", () => {
  const ADAPTER_BASE = { organization: "contoso", project: "payments", repository: "checkout", pat: "test-pat" };

  it("returns the authenticated user's id from connectionData", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => mockResponse({ authenticatedUser: { id: "guid-1" } }));
    const adapter = new AzureDevOpsAdapter({ ...ADAPTER_BASE, fetchFn });
    expect(await adapter.getAuthenticatedUserId()).toBe("guid-1");
    expect(String(fetchFn.mock.calls[0]![0])).toBe("https://dev.azure.com/contoso/_apis/connectionData?api-version=7.1-preview");
  });

  it("returns undefined when the identity cannot be read", async () => {
    const adapter = new AzureDevOpsAdapter({ ...ADAPTER_BASE, fetchFn: vi.fn<typeof fetch>(async () => mockResponse({}, 401)) });
    expect(await adapter.getAuthenticatedUserId()).toBeUndefined();
  });
});
