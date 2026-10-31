import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMonthlyJql,
  createMonthlyProgressPrinter,
  parseMonth,
  runGenerateMonthlyReleaseNotes,
  searchIssueKeys,
  type GenerateMonthlyReleaseNotesInput,
  type MonthlyProgressEvent,
} from "../src/cli/generateMonthlyReleaseNotes.js";
import type { ContextProvider } from "../src/context/providerRegistry.js";
import { MonthlyReleaseNotesPackSchema } from "../src/domain/releaseNotes/schema.js";
import { AtlassianRestClient } from "../src/integrations/atlassianRest/client.js";
import type { LlmTextClient, LlmTextGenerationRequest } from "../src/integrations/llm/types.js";
import { CliError } from "../src/shared/cli.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Completion time and simulated fetch latency per change; ITSM-2 cannot be fetched. */
const CHANGES: Record<string, { title: string; completedAt: string; latencyMs: number }> = {
  "ITSM-3": { title: "Upgrade payment gateway", completedAt: "2026-10-03T10:00:00.000+0200", latencyMs: 40 },
  "ITSM-1": { title: "Rotate Manso Pay certificates", completedAt: "2026-10-20T08:00:00.000+0200", latencyMs: 1 },
  "ITSM-2": { title: "Broken change", completedAt: "2026-10-21T08:00:00.000+0200", latencyMs: 1 },
};

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Jira search paged over two pages: ITSM-3, ITSM-1 | ITSM-2. */
function searchingJira(queries: string[] = []): AtlassianRestClient {
  return new AtlassianRestClient({
    jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" },
    fetchFn: async (url) => {
      const parsed = new URL(String(url));
      queries.push(parsed.searchParams.get("jql") ?? "");
      return parsed.searchParams.get("nextPageToken") === "page-2"
        ? mockResponse({ issues: [{ key: "ITSM-2" }], isLast: true })
        : mockResponse({ issues: [{ key: "ITSM-3" }, { key: "ITSM-1" }], nextPageToken: "page-2", isLast: false });
    },
  });
}

interface ProviderStats {
  created: number;
  inFlight: number;
  peak: number;
}

function providerFactory(stats: ProviderStats): () => ContextProvider {
  return () => {
    stats.created += 1;
    stats.inFlight += 1;
    stats.peak = Math.max(stats.peak, stats.inFlight);
    const id = stats.created;
    return {
      getSourceName: () => "jira-rest",
      getIssue: async (key: string) => {
        const change = CHANGES[key];
        await delay(change?.latencyMs ?? 1);
        if (!change || key === "ITSM-2") throw new Error(`jira REST 500 for ${key}`);
        return {
          ticket: {
            key,
            title: change.title,
            issueType: "[System] Change",
            status: "Completed",
            statusCategory: "done",
            labels: [],
            components: [],
            affectedServices: ["Manso Pay"],
            completedAt: change.completedAt,
            assignee: { name: `Owner of ${key}` },
            url: `https://example.atlassian.net/browse/${key}`,
            links: [],
          },
          description: { format: "text", text: `${change.title} description.` },
          comments: [],
          linkedIssues: [],
        };
      },
      getComments: async () => [],
      getAttachments: async () => [],
      getLinkedIssues: async () => [],
      getDevelopmentLinks: async () => ({ branches: [], pullRequests: [] }),
      getConfluencePages: async () => [],
      getProvenance: () => [],
      // A per-instance warning: proves warnings do not leak between releases.
      getWarnings: () => [{ section: "context", message: `provider-${id}` }],
      close: async () => {
        stats.inFlight -= 1;
      },
    };
  };
}

function routerLlm(options: { monthlyFails?: boolean } = {}): LlmTextClient {
  return {
    provider: "anthropic",
    model: "stub",
    toolName: "stub:test",
    async generateText(req: LlmTextGenerationRequest): Promise<string> {
      if (req.operation === "release-notes-monthly-summary") {
        if (options.monthlyFails) throw new Error("summary LLM down");
        return JSON.stringify({
          title: "ITSM releases, October 2026",
          summary: "October hardened payments.",
          highlights: ["Gateway upgraded", "Certificates rotated"],
        });
      }
      if (req.operation === "release-notes-author") {
        const title = /# Release Ticket: (.+)/.exec(req.userPrompt)?.[1] ?? "Release";
        const key = /key: (ITSM-\d+)\)/.exec(req.userPrompt)?.[1] ?? "UNKNOWN";
        return JSON.stringify({
          title,
          audience: "stakeholders",
          summary: `${title} shipped.`,
          highlights: [title],
          changeItems: [{ area: "Payments", description: `${title} done.` }],
          deploymentNotes: [],
          testingNotes: [],
          knownRisks: [],
          ticketSummaries: [],
          releaseEntries: [{ key, section: "maintenance", description: `${title} done.`, why: "Keeps payments secure.", insufficientContext: false }],
          actionNeeded: [],
        });
      }
      throw new Error(`Unexpected LLM operation: ${req.operation}`);
    },
  };
}

describe("parseMonth", () => {
  it.each([
    ["10/26", "2026-10"],
    ["1/26", "2026-01"],
    ["10/2026", "2026-10"],
    ["2026-10", "2026-10"],
  ])("parses %j as %j", (input, month) => {
    expect(parseMonth(input)).toBe(month);
  });

  it.each(["13/26", "2026/10", "October", "", "0/26"])("rejects %j", (input) => {
    expect(() => parseMonth(input)).toThrow(CliError);
  });
});

describe("buildMonthlyJql", () => {
  it("selects completed releases by completion date, with a resolved-date fallback", () => {
    expect(buildMonthlyJql({ project: "ITSM", issueType: "10903", month: "2026-10" })).toBe(
      'project = ITSM AND issuetype = 10903 AND status = "Completed" AND ' +
        '(("Change completion date" >= "2026-10-01" AND "Change completion date" < "2026-11-01") OR ' +
        '("Change completion date" is EMPTY AND resolved >= "2026-10-01" AND resolved < "2026-11-01")) ' +
        'ORDER BY "Change completion date" ASC',
    );
  });

  it("rolls December over to January and ANDs extra JQL in parentheses", () => {
    const jql = buildMonthlyJql({ project: "ITSM", issueType: "[System] Change", month: "2026-12", extraJql: 'labels = a OR labels = b' });
    expect(jql).toContain('issuetype = "[System] Change"');
    expect(jql).toContain('< "2027-01-01"');
    expect(jql).toContain("AND (labels = a OR labels = b) ORDER BY");
  });

  it("escapes quotes in names and rejects a malformed project key", () => {
    expect(buildMonthlyJql({ project: "ITSM", issueType: "10903", month: "2026-10", status: 'Done "ok"' })).toContain(
      'status = "Done \\"ok\\""',
    );
    expect(() => buildMonthlyJql({ project: "itsm OR 1=1", issueType: "10903", month: "2026-10" })).toThrow(CliError);
  });
});

describe("searchIssueKeys", () => {
  it("pages with nextPageToken until isLast", async () => {
    const queries: string[] = [];
    expect(await searchIssueKeys(searchingJira(queries), "project = ITSM")).toEqual(["ITSM-3", "ITSM-1", "ITSM-2"]);
    expect(queries).toHaveLength(2);
  });
});

describe("runGenerateMonthlyReleaseNotes", () => {
  let outDir: string;
  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "manso-monthly-"));
  });
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  function input(overrides: Partial<GenerateMonthlyReleaseNotesInput> = {}, stats?: ProviderStats): GenerateMonthlyReleaseNotesInput {
    return {
      project: "ITSM",
      issueType: "10903",
      month: "2026-10",
      outDir,
      providerFactory: providerFactory(stats ?? { created: 0, inFlight: 0, peak: 0 }),
      llm: routerLlm(),
      jira: searchingJira(),
      vcsTokens: {},
      ...overrides,
    };
  }

  it("builds every matched release in parallel, keeps search order, skips failures, and writes three files", async () => {
    const stats: ProviderStats = { created: 0, inFlight: 0, peak: 0 };
    const result = await runGenerateMonthlyReleaseNotes(input({ concurrency: 2 }, stats));

    expect(result).toMatchObject({ matchedCount: 3, processedCount: 2, failedKeys: ["ITSM-2"] });
    expect(result.jsonPath).toBe(join(outDir, "ITSM-2026-10", "release-notes.json"));
    expect(stats.created).toBe(3);
    expect(stats.peak).toBe(2);
    expect(stats.inFlight).toBe(0);

    const pack = MonthlyReleaseNotesPackSchema.parse(JSON.parse(await readFile(result.jsonPath, "utf8")));
    // ITSM-3 is the slowest fetch but comes first in the search, so it stays first.
    expect(pack.releases.map((r) => r.releaseIssueKey)).toEqual(["ITSM-3", "ITSM-1"]);
    expect(pack.jql).toContain("issuetype = 10903");
    expect(pack.provenance.concurrency).toBe(2);
    expect(pack.warnings.some((w) => w.message.includes("ITSM-2") && w.message.includes("skipped"))).toBe(true);
    // One provider per release: each pack carries exactly its own provider's warning.
    const providerWarnings = pack.releases.map((r) => r.warnings.filter((w) => w.message.startsWith("provider-")).map((w) => w.message));
    expect(providerWarnings.every((w) => w.length === 1)).toBe(true);
    expect(new Set(providerWarnings.flat()).size).toBe(2);

    const internal = await readFile(result.markdownPath, "utf8");
    expect(internal).toContain("# ITSM releases, October 2026");
    expect(internal).toContain("| **Release Version** | ITSM October 2026 |");
    expect(internal).toContain("| **Release Date** | from 2026-10-03 till 2026-10-20 |");
    expect(internal).toContain("| **Contributors** | Owner of ITSM-3, Owner of ITSM-1 |");
    expect(internal).toContain(
      "| Upgrade payment gateway done. *Why:* Keeps payments secure. | [ITSM-3](https://example.atlassian.net/browse/ITSM-3) | Manso Pay | 2026-10-03 |",
    );
    expect(internal).toContain("## Releases this month");
    expect(internal).toContain("| [ITSM-1](https://example.atlassian.net/browse/ITSM-1) | Rotate Manso Pay certificates | 2026-10-20 | 1 |");
    expect(internal).toContain("- **ITSM-2**: release notes could not be generated");

    const external = await readFile(result.externalMarkdownPath, "utf8");
    expect(external).toContain("October hardened payments.");
    expect(external).toContain("### Upgrade payment gateway");
    expect(external).toContain("_Released 2026-10-03_");
    expect(external).not.toMatch(/ITSM-\d/);
    expect(external).not.toContain("https://");
    expect(external).not.toContain("Owner of");
  });

  it("reports structured progress: matched, each release start/finish, then summarising", async () => {
    const events: MonthlyProgressEvent[] = [];
    await runGenerateMonthlyReleaseNotes(input({ concurrency: 1, onProgress: (e) => events.push(e) }));

    expect(events.map((e) => (e.type === "release-finished" ? `${e.type}:${e.key}:${e.ok}` : "key" in e ? `${e.type}:${e.key}` : e.type))).toEqual([
      "matched",
      "release-started:ITSM-3",
      "release-finished:ITSM-3:true",
      "release-started:ITSM-1",
      "release-finished:ITSM-1:true",
      "release-started:ITSM-2",
      "release-finished:ITSM-2:false",
      "summarising",
    ]);
    expect(events[0]).toEqual({ type: "matched", scope: "ITSM 2026-10", total: 3, concurrency: 1 });
    expect(events[2]).toMatchObject({ rows: 1, excluded: 0, fallback: false });
    expect(events[6]).toMatchObject({ ok: false, error: expect.stringContaining("jira REST 500") });
  });

  it("prints one line per release when stderr is not a terminal (CI logs)", async () => {
    let out = "";
    const printer = createMonthlyProgressPrinter({ isTTY: false, write: (chunk: string) => (out += chunk) }, () => 0);
    await runGenerateMonthlyReleaseNotes(input({ concurrency: 1, onProgress: printer.onProgress }));
    printer.finish();

    const lines = out.trim().split("\n");
    expect(lines[0]).toBe("Matched 3 release(s) for ITSM 2026-10; processing 1 at a time.");
    expect(lines[1]).toMatch(/^\[1\/3\] ITSM-3 done \(0s, 1 row\(s\)\) · 0s elapsed/);
    expect(lines[3]).toMatch(/^\[3\/3\] ITSM-2 FAILED \(.*jira REST 500.*\)/);
    expect(lines[4]).toBe("Writing the month summary over 2 release(s)...");
    expect(out).not.toContain("\x1b");
    expect(printer.fallbackKeys()).toEqual([]);
  });

  it("writes a fallback monthly summary, with a warning, when the summary LLM call fails", async () => {
    const result = await runGenerateMonthlyReleaseNotes(input({ llm: routerLlm({ monthlyFails: true }) }));
    const pack = MonthlyReleaseNotesPackSchema.parse(JSON.parse(await readFile(result.jsonPath, "utf8")));
    expect(pack.summary.title).toBe("ITSM releases, October 2026");
    expect(pack.summary.highlights).toEqual(["Upgrade payment gateway", "Rotate Manso Pay certificates"]);
    expect(pack.warnings.some((w) => w.toolName === "llm:release-notes-monthly" && w.message.includes("summary LLM down"))).toBe(true);
  });

  it("fails loudly when no matched release could be built", async () => {
    const failing = (): ContextProvider => ({
      ...providerFactory({ created: 0, inFlight: 0, peak: 0 })(),
      getIssue: async () => {
        throw new Error("jira down");
      },
    });
    await expect(runGenerateMonthlyReleaseNotes(input({ providerFactory: failing }))).rejects.toThrow(
      /could not be built for any of the 3 matched/,
    );
  });

  it("writes an empty month without error when nothing matches", async () => {
    const empty = new AtlassianRestClient({
      jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" },
      fetchFn: async () => mockResponse({ issues: [], isLast: true }),
    });
    const result = await runGenerateMonthlyReleaseNotes(input({ jira: empty }));
    expect(result).toMatchObject({ matchedCount: 0, processedCount: 0, failedKeys: [] });
    const pack = MonthlyReleaseNotesPackSchema.parse(JSON.parse(await readFile(result.jsonPath, "utf8")));
    expect(pack.releases).toEqual([]);
    expect(pack.warnings).toEqual([]);
    // An empty month is not an LLM failure.
    expect(pack.summary.summary).toBe("No releases completed in October 2026.");
    expect(pack.summary.summary).not.toMatch(/fallback|failed/i);
  });
});
