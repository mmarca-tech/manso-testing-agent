import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGenerateReleaseNotes } from "../src/cli/generateReleaseNotes.js";
import type { ContextProvider } from "../src/context/providerRegistry.js";
import { AtlassianRestClient } from "../src/integrations/atlassianRest/client.js";
import type { LlmTextClient, LlmTextGenerationRequest } from "../src/integrations/llm/types.js";
import type { VcsAdapter, VcsPullRequestDiff } from "../src/integrations/vcs/adapter.js";
import type { VcsResolution } from "../src/integrations/vcs/resolve.js";
import { ReleaseNotesPackSchema } from "../src/domain/releaseNotes/schema.js";
import { renderReleaseNotesMarkdown, renderTeamReleaseNotesMarkdown } from "../src/output/release-notes/renderer.js";
import { formatReleaseNotesAsComment } from "../src/agents/releaseNotesAuthor/index.js";

const PR_URL = "https://dev.azure.com/contoso/payments/_git/checkout/pullrequest/42";
const BRANCH_NAME = "feature/secret-branch-name";

const { resolveVcsAdapterMock } = vi.hoisted(() => ({ resolveVcsAdapterMock: vi.fn() }));

vi.mock("../src/integrations/vcs/resolve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/integrations/vcs/resolve.js")>()),
  resolveVcsAdapter: resolveVcsAdapterMock,
}));

function stubProvider(overrides: Partial<ContextProvider> = {}): ContextProvider {
  return {
    getSourceName: () => "jira-rest",
    getIssue: async (key: string) => {
      if (key === "REL-1") {
        return {
          ticket: {
            key,
            title: "October Release",
            labels: [],
            components: [],
            links: [],
            fixVersions: [{ name: "2026.10", released: false, releaseDate: "2026-10-14" }],
          },
          description: { format: "text", text: "Release ticket for October." },
          comments: [],
          linkedIssues: [
            { direction: "outward", relationship: "relates to", issueKey: "PROJ-1", title: "Speed up checkout", issueType: "Story" },
            { direction: "outward", relationship: "relates to", issueKey: "PROJ-2", title: "Fix login bug", issueType: "Bug" },
          ],
        };
      }
      if (key === "PROJ-1") {
        return {
          ticket: {
            key,
            title: "Speed up checkout",
            issueType: "Story",
            status: "Done",
            statusCategory: "done",
            labels: [],
            components: ["Checkout"],
            affectedServices: ["Checkout API"],
            fixVersions: [{ name: "2026.10", releaseDate: "2026-10-14" }],
            assignee: { name: "Dev One" },
            url: "https://example.atlassian.net/browse/PROJ-1",
            links: [],
          },
          description: { format: "text", text: "Checkout was slow." },
          comments: [],
          linkedIssues: [],
        };
      }
      return {
        ticket: {
          key,
          title: "Fix login bug",
          issueType: "Bug",
          status: "Done",
          statusCategory: "done",
          labels: [],
          components: ["Login"],
          url: "https://example.atlassian.net/browse/PROJ-2",
          links: [],
        },
        description: { format: "text", text: "Login occasionally failed." },
        comments: [],
        linkedIssues: [],
      };
    },
    getComments: async () => [],
    getAttachments: async () => [],
    getLinkedIssues: async () => [],
    getDevelopmentLinks: async (key: string) => {
      if (key === "PROJ-1") {
        return {
          branches: [{ name: BRANCH_NAME }],
          pullRequests: [{ title: "Speed up checkout query", url: PR_URL }],
        };
      }
      return { branches: [], pullRequests: [] };
    },
    getConfluencePages: async () => [],
    getProvenance: () => [],
    getWarnings: () => [],
    close: async () => undefined,
    ...overrides,
  };
}

function routerLlm(authorPrompts: string[] = []): LlmTextClient {
  return {
    provider: "anthropic",
    model: "stub",
    toolName: "stub:test",
    async generateText(req: LlmTextGenerationRequest): Promise<string> {
      switch (req.operation) {
        case "release-notes-pr-summary":
          return JSON.stringify({
            summary: "Optimized the checkout database query.",
            changeAreas: ["checkout"],
            risks: [],
          });
        case "release-notes-author":
          authorPrompts.push(req.userPrompt);
          return JSON.stringify({
            title: "October Release",
            audience: "customers",
            summary: "This release speeds up checkout and fixes an occasional login issue.",
            highlights: ["Faster checkout", "More reliable login"],
            changeItems: [
              { area: "Checkout", description: "Checkout is now faster." },
              { area: "Login", description: "Login no longer fails intermittently." },
            ],
            deploymentNotes: [],
            testingNotes: [],
            knownRisks: [],
            ticketSummaries: [
              { key: "PROJ-1", title: "Speed up checkout", summary: "Checkout latency reduced." },
              { key: "PROJ-2", title: "Fix login bug", summary: "Login reliability improved." },
            ],
            releaseEntries: [
              { key: "PROJ-1", section: "newFeature", description: "Checkout is now faster.", why: "Fewer abandoned carts.", insufficientContext: false },
              { key: "PROJ-2", section: "bugFix", description: "Login no longer fails intermittently.", insufficientContext: false },
            ],
            actionNeeded: [],
          });
        default:
          throw new Error(`Unexpected LLM operation: ${req.operation}`);
      }
    },
  };
}

function fakeVcsAdapter(diff: VcsPullRequestDiff): VcsAdapter {
  return {
    kind: "azure-devops",
    async raisePullRequest() {
      throw new Error("not used in this test");
    },
    async getPullRequestDiff() {
      return diff;
    },
  };
}

function okResolution(diff: VcsPullRequestDiff): VcsResolution {
  return { ok: true, kind: "azure-devops", description: "contoso/payments/checkout", adapter: fakeVcsAdapter(diff) };
}

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("runGenerateReleaseNotes", () => {
  let outDir: string;
  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "manso-relnotes-"));
    resolveVcsAdapterMock.mockReset();
  });
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("happy path: 2 linked tickets, 1 analyzed PR, external output has no leakage, internal output is traceable", async () => {
    resolveVcsAdapterMock.mockResolvedValue(
      okResolution({
        files: [
          { path: "src/checkout/query.ts", changeType: "edit" },
          { path: "src/checkout/index.ts", changeType: "edit" },
        ],
        hasPatches: false,
      }),
    );

    const jira = new AtlassianRestClient({
      jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" },
      fetchFn: async () => mockResponse({ id: "10100" }, 201),
    });

    const result = await runGenerateReleaseNotes({
      issueKey: "REL-1",
      outDir,
      provider: stubProvider(),
      llm: routerLlm(),
      jira,
      repoRoot: "/fake/repo",
      vcsTokens: {},
      postComment: false,
    });

    expect(result.linkedTicketCount).toBe(2);
    expect(result.pullRequestsAnalyzed).toBe(1);

    const jsonRaw = await readFile(result.jsonPath, "utf8");
    const pack = ReleaseNotesPackSchema.parse(JSON.parse(jsonRaw));
    expect(pack.linkedTicketKeys.sort()).toEqual(["PROJ-1", "PROJ-2"]);
    expect(pack.pullRequestsAnalyzed).toBe(1);

    const external = renderReleaseNotesMarkdown(pack);
    expect(await readFile(result.externalMarkdownPath, "utf8")).toBe(external);
    for (const leaked of [PR_URL, BRANCH_NAME, "REL-1", "PROJ-1", "PROJ-2"]) {
      expect(external).not.toContain(leaked);
    }

    // Internal outputs follow the team template: ticket links are intended,
    // but branches and PR URLs still never appear.
    const internal = renderTeamReleaseNotesMarkdown(pack);
    expect(await readFile(result.markdownPath, "utf8")).toBe(internal);
    const comment = JSON.stringify(formatReleaseNotesAsComment(pack));
    for (const output of [internal, comment]) {
      expect(output).not.toContain(PR_URL);
      expect(output).not.toContain(BRANCH_NAME);
      expect(output).toContain("https://example.atlassian.net/browse/PROJ-1");
    }
    expect(internal).toContain(
      "| Checkout is now faster. *Why:* Fewer abandoned carts. | [PROJ-1](https://example.atlassian.net/browse/PROJ-1) | Checkout API, Checkout | 2026-10-14 |",
    );
    expect(internal).toContain("| **Release Version** | 2026.10 |");
    expect(internal).toContain("| **Contributors** | Dev One |");

    expect(pack.releaseMetadata).toEqual({ version: "2026.10", dateFrom: "2026-10-14", dateTo: "2026-10-14", contributors: ["Dev One"] });
    expect(pack.teamTemplate.newFeatures.map((r) => r.ticketKey)).toEqual(["PROJ-1"]);
    expect(pack.teamTemplate.bugFixes.map((r) => r.ticketKey)).toEqual(["PROJ-2"]);
    expect(pack.teamTemplate.bugFixes[0]?.insufficientContext).toBe(true);
    expect(pack.excludedTickets).toEqual([]);
  });

  it("excludes linked tickets that are not done: no PR analysis, not in the prompt, listed for the reviewer", async () => {
    resolveVcsAdapterMock.mockResolvedValue(okResolution({ files: [{ path: "src/a.ts", changeType: "edit" }], hasPatches: false }));
    const jira = new AtlassianRestClient({
      jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" },
      fetchFn: async () => mockResponse({ id: "1" }, 201),
    });
    const base = stubProvider();
    const authorPrompts: string[] = [];

    const result = await runGenerateReleaseNotes({
      issueKey: "REL-1",
      outDir,
      provider: stubProvider({
        getIssue: async (key: string) => {
          const issue = await base.getIssue(key);
          return key === "PROJ-1"
            ? { ...issue, ticket: { ...issue.ticket, status: "In Review", statusCategory: "indeterminate" } }
            : issue;
        },
      }),
      llm: routerLlm(authorPrompts),
      jira,
      repoRoot: "/fake/repo",
      vcsTokens: {},
      postComment: false,
    });

    expect(result.linkedTicketCount).toBe(1);
    expect(result.excludedTicketCount).toBe(1);
    expect(result.pullRequestsAnalyzed).toBe(0);
    expect(authorPrompts).toHaveLength(1);
    expect(authorPrompts[0]).not.toContain("Linked Ticket: Speed up checkout");

    const pack = ReleaseNotesPackSchema.parse(JSON.parse(await readFile(result.jsonPath, "utf8")));
    expect(pack.linkedTicketKeys).toEqual(["PROJ-2"]);
    expect(pack.excludedTickets).toEqual([
      { key: "PROJ-1", title: "Speed up checkout", status: "In Review", reason: "Not done (status: In Review)." },
    ]);
    // The stub LLM still wrote an entry for the excluded ticket; it must not resurface.
    expect(pack.teamTemplate.newFeatures).toEqual([]);
    expect(pack.warnings.some((w) => w.message.includes("PROJ-1") && w.message.includes("not in this release's scope"))).toBe(true);
    expect(await readFile(result.markdownPath, "utf8")).toContain("## Excluded from these notes (reviewer only)");
  });

  it("passes --max-linked through to runResearcher's maxRelatedTickets (caps related tickets)", async () => {
    resolveVcsAdapterMock.mockResolvedValue({ ok: false, reason: "no remote" });
    const jira = new AtlassianRestClient({
      jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" },
      fetchFn: async () => mockResponse({ id: "1" }, 201),
    });

    const result = await runGenerateReleaseNotes({
      issueKey: "REL-1",
      outDir,
      provider: stubProvider(),
      llm: routerLlm(),
      jira,
      vcsTokens: {},
      maxLinkedTickets: 1,
      postComment: false,
    });

    expect(result.linkedTicketCount).toBe(1);
  });

  it("falls back to buildFallbackReleaseNotes when authorReleaseNotes's LLM call throws, without throwing itself", async () => {
    const jira = new AtlassianRestClient({
      jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" },
      fetchFn: async () => mockResponse({ id: "1" }, 201),
    });

    const throwingLlm: LlmTextClient = {
      provider: "anthropic",
      model: "stub",
      toolName: "stub:test",
      async generateText(req: LlmTextGenerationRequest): Promise<string> {
        if (req.operation === "release-notes-author") {
          throw new Error("LLM is down");
        }
        return JSON.stringify({ summary: "x", changeAreas: [], risks: [] });
      },
    };

    const result = await runGenerateReleaseNotes({
      issueKey: "REL-1",
      outDir,
      provider: stubProvider(),
      llm: throwingLlm,
      jira,
      vcsTokens: {},
      postComment: false,
    });

    expect(result.notesTitle).toBe("October Release");
    // Fallback still yields a template: classified by issue type and flagged for review.
    const pack = ReleaseNotesPackSchema.parse(JSON.parse(await readFile(result.jsonPath, "utf8")));
    expect(pack.teamTemplate.newFeatures.map((r) => [r.ticketKey, r.insufficientContext])).toEqual([["PROJ-1", true]]);
    expect(pack.teamTemplate.bugFixes.map((r) => [r.ticketKey, r.insufficientContext])).toEqual([["PROJ-2", true]]);
  });

  it("does not post fallback notes to Jira and records a warning", async () => {
    const postedBodies: unknown[] = [];
    const jira = new AtlassianRestClient({
      jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" },
      fetchFn: async (_url, init) => {
        postedBodies.push(init?.body);
        return mockResponse({ id: "1" }, 201);
      },
    });

    const throwingLlm: LlmTextClient = {
      provider: "anthropic",
      model: "stub",
      toolName: "stub:test",
      async generateText(req: LlmTextGenerationRequest): Promise<string> {
        if (req.operation === "release-notes-author") {
          throw new Error("LLM is down");
        }
        return JSON.stringify({ summary: "x", changeAreas: [], risks: [] });
      },
    };

    const result = await runGenerateReleaseNotes({
      issueKey: "REL-1",
      outDir,
      provider: stubProvider(),
      llm: throwingLlm,
      jira,
      vcsTokens: {},
      postComment: true,
      dryRun: false,
    });

    expect(result.commentPosted).toBe(false);
    expect(postedBodies).toEqual([]);
    const pack = ReleaseNotesPackSchema.parse(JSON.parse(await readFile(result.jsonPath, "utf8")));
    expect(pack.provenance.commentPosted).toBe(false);
    expect(pack.warnings.some((w) => w.toolName === "llm:release-notes" && w.message.includes("LLM is down"))).toBe(true);
  });

  it("records a warning when the PR diff is reported incomplete", async () => {
    resolveVcsAdapterMock.mockResolvedValue(
      okResolution({
        files: [{ path: "src/checkout/query.ts", changeType: "edit" }],
        hasPatches: false,
        allChangesIncluded: false,
        warnings: ["Changed-file list capped at 1000 entries."],
      }),
    );
    const jira = new AtlassianRestClient({
      jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" },
      fetchFn: async () => mockResponse({ id: "1" }, 201),
    });

    const result = await runGenerateReleaseNotes({
      issueKey: "REL-1",
      outDir,
      provider: stubProvider(),
      llm: routerLlm(),
      jira,
      repoRoot: "/fake/repo",
      vcsTokens: {},
      postComment: false,
    });

    const pack = ReleaseNotesPackSchema.parse(JSON.parse(await readFile(result.jsonPath, "utf8")));
    expect(pack.warnings.some((w) => w.toolName === "vcs" && w.message.includes("capped at 1000"))).toBe(true);
  });

  it("analyzes GitHub PR URLs when the resolved adapter is GitHub", async () => {
    const requestedIds: number[] = [];
    resolveVcsAdapterMock.mockResolvedValue({
      ok: true,
      kind: "github",
      description: "contoso/checkout",
      adapter: {
        kind: "github",
        async raisePullRequest() {
          throw new Error("not used in this test");
        },
        async getPullRequestDiff(id: number) {
          requestedIds.push(id);
          return { files: [{ path: "src/checkout/query.ts", changeType: "edit" }], hasPatches: false };
        },
      },
    } satisfies VcsResolution);

    const jira = new AtlassianRestClient({
      jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" },
      fetchFn: async () => mockResponse({ id: "1" }, 201),
    });

    const result = await runGenerateReleaseNotes({
      issueKey: "REL-1",
      outDir,
      provider: stubProvider({
        getDevelopmentLinks: async (key: string) => ({
          branches: [],
          pullRequests: key === "PROJ-1" ? [{ title: "Speed up checkout query", url: "https://github.com/contoso/checkout/pull/42" }] : [],
        }),
      }),
      llm: routerLlm(),
      jira,
      repoRoot: "/fake/repo",
      vcsTokens: {},
      postComment: false,
    });

    expect(requestedIds).toEqual([42]);
    expect(result.pullRequestsAnalyzed).toBe(1);
  });

  it("succeeds with pullRequestsAnalyzed === 0 and a warning when --repo is omitted", async () => {
    const jira = new AtlassianRestClient({
      jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" },
      fetchFn: async () => mockResponse({ id: "1" }, 201),
    });

    const result = await runGenerateReleaseNotes({
      issueKey: "REL-1",
      outDir,
      provider: stubProvider(),
      llm: routerLlm(),
      jira,
      vcsTokens: {},
      postComment: false,
    });

    expect(result.pullRequestsAnalyzed).toBe(0);
    expect(resolveVcsAdapterMock).not.toHaveBeenCalled();

    const jsonRaw = await readFile(result.jsonPath, "utf8");
    const pack = ReleaseNotesPackSchema.parse(JSON.parse(jsonRaw));
    expect(pack.warnings.some((w) => w.toolName === "vcs")).toBe(true);
  });

  it("records commentPosted: false and a warning when posting the Jira comment fails, without throwing", async () => {
    resolveVcsAdapterMock.mockResolvedValue({ ok: false, reason: "no remote" });
    const jira = new AtlassianRestClient({
      jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" },
      fetchFn: async () => mockResponse({ message: "forbidden" }, 403),
    });

    const result = await runGenerateReleaseNotes({
      issueKey: "REL-1",
      outDir,
      provider: stubProvider(),
      llm: routerLlm(),
      jira,
      vcsTokens: {},
      postComment: true,
      dryRun: false,
    });

    expect(result.commentPosted).toBe(false);
    const jsonRaw = await readFile(result.jsonPath, "utf8");
    const pack = ReleaseNotesPackSchema.parse(JSON.parse(jsonRaw));
    expect(pack.provenance.commentPosted).toBe(false);
    expect(pack.warnings.some((w) => w.toolName === "jira:comment")).toBe(true);
  });
});
