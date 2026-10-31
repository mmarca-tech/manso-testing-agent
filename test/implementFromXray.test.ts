import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtlassianRestClient } from "../src/integrations/atlassianRest/client.js";
import { XrayCloudClient } from "../src/integrations/xray/client.js";
import { buildTestDesignFromXray } from "../src/cli/implementFromXray.js";

interface LinkedSpec { key: string; summary: string; testType?: string; gherkin?: string; }

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function defaultGherkin(title: string): string {
  return `Scenario: ${title}\n  Given a precondition\n  When an action\n  Then a result`;
}

function buildFetchFn(opts: { summary?: string; linked: LinkedSpec[] }): typeof fetch {
  const calls: string[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (url: string | URL | Request, init?: RequestInit) => {
    const u = url.toString();
    calls.push(u);
    if (u.includes("/api/v2/authenticate")) {
      return mockResponse("xray-token");
    }
    if (u.includes("/api/v2/graphql")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (String(body.query).includes("getTests")) {
        const results = opts.linked.map((t) => ({
          issueId: t.key,
          jira: { key: t.key, summary: t.summary },
          testType: { name: t.testType ?? "Cucumber" },
          gherkin: t.gherkin ?? defaultGherkin(t.summary),
        }));
        return mockResponse({ data: { getTests: { results } } });
      }
      return mockResponse({ data: {} });
    }
    if (u.includes("/rest/api/3/issue/")) {
      if (u.includes("fields=issuelinks")) {
        const issuelinks = opts.linked.map((t) => ({
          type: { name: "Test" },
          // Use "Test Case" (not "Test") to lock the issue-type matching fix —
          // some Jira instances name the Xray test issue type "Test Case".
          outwardIssue: { key: t.key, fields: { issuetype: { name: "Test Case" }, summary: t.summary } },
        }));
        return mockResponse({ fields: { issuelinks } });
      }
      return mockResponse({ fields: { summary: opts.summary ?? "Story title" } });
    }
    return mockResponse({ error: `unhandled: ${u}` }, 500);
  });
  (fetchFn as unknown as { __calls: string[] }).__calls = calls;
  return fetchFn;
}

function getCalls(fetchFn: typeof fetch): string[] {
  return (fetchFn as unknown as { __calls: string[] }).__calls;
}

function clients(fetchFn: typeof fetch): { jira: AtlassianRestClient; xray: XrayCloudClient } {
  return {
    jira: new AtlassianRestClient({ jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" }, fetchFn }),
    xray: new XrayCloudClient({ baseUrl: "https://xray.cloud.getxray.app", clientId: "id", clientSecret: "secret", fetchFn }),
  };
}

describe("buildTestDesignFromXray", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "manso-fromxray-"));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  async function writeFeature(...scenarioTitles: string[]): Promise<void> {
    const dir = join(repoRoot, "features");
    await mkdir(dir, { recursive: true });
    const body = ["Feature: Existing", ...scenarioTitles.flatMap((t) => [`  Scenario: ${t}`, "    Given x", "    When y", "    Then z"])].join("\n");
    await writeFile(join(dir, "existing.feature"), `${body}\n`, "utf8");
  }

  it("implements only the linked tests not already in the repo", async () => {
    await writeFeature("Login works");
    const fetchFn = buildFetchFn({ linked: [
      { key: "TEST-1", summary: "Login works" },
      { key: "TEST-2", summary: "Logout works" },
    ] });
    const { jira, xray } = clients(fetchFn);

    const result = await buildTestDesignFromXray({ ticketKey: "FINT-1", repoRoot, jira, xray });

    expect(result.kind).toBe("pack");
    if (result.kind !== "pack") return;
    expect(result.summary.linkedTests).toBe(2);
    expect(result.summary.alreadyImplemented).toBe(1);
    expect(result.summary.toImplement).toBe(1);
    expect(result.pack.scenarios).toHaveLength(1);
    expect(result.pack.scenarios[0]?.title).toBe("Logout works");
    expect(result.pack.ticket).toEqual({ key: "FINT-1", title: "Story title" });
  });

  it("returns nothing-to-do and never calls getTests when there are no linked tests", async () => {
    await writeFeature();
    const fetchFn = buildFetchFn({ linked: [] });
    const { jira, xray } = clients(fetchFn);

    const result = await buildTestDesignFromXray({ ticketKey: "FINT-1", repoRoot, jira, xray });

    expect(result.kind).toBe("nothing-to-do");
    expect(result.summary.linkedTests).toBe(0);
    expect(getCalls(fetchFn).some((u) => u.includes("/api/v2/graphql"))).toBe(false);
  });

  it("returns nothing-to-do when every linked test is already implemented", async () => {
    await writeFeature("Login works", "Logout works");
    const fetchFn = buildFetchFn({ linked: [
      { key: "TEST-1", summary: "Login works" },
      { key: "TEST-2", summary: "Logout works" },
    ] });
    const { jira, xray } = clients(fetchFn);

    const result = await buildTestDesignFromXray({ ticketKey: "FINT-1", repoRoot, jira, xray });

    expect(result.kind).toBe("nothing-to-do");
    expect(result.summary.alreadyImplemented).toBe(2);
  });

  it("skips non-Cucumber linked tests with a warning", async () => {
    await writeFeature();
    const fetchFn = buildFetchFn({ linked: [
      { key: "TEST-1", summary: "Manual check", testType: "Manual" },
      { key: "TEST-2", summary: "Automatable" },
    ] });
    const { jira, xray } = clients(fetchFn);

    const result = await buildTestDesignFromXray({ ticketKey: "FINT-1", repoRoot, jira, xray });

    expect(result.kind).toBe("pack");
    if (result.kind !== "pack") return;
    expect(result.pack.scenarios).toHaveLength(1);
    expect(result.pack.scenarios[0]?.title).toBe("Automatable");
    expect(result.summary.warnings.some((w) => w.message.includes("Manual"))).toBe(true);
  });

  it("counts parse failures and keeps the parseable tests", async () => {
    await writeFeature();
    const fetchFn = buildFetchFn({ linked: [
      { key: "TEST-1", summary: "Broken", gherkin: "Scenario: Broken\n" }, // no steps → parse error
      { key: "TEST-2", summary: "Good" },
    ] });
    const { jira, xray } = clients(fetchFn);

    const result = await buildTestDesignFromXray({ ticketKey: "FINT-1", repoRoot, jira, xray });

    expect(result.kind).toBe("pack");
    if (result.kind !== "pack") return;
    expect(result.summary.parseFailures).toBe(1);
    expect(result.pack.scenarios).toHaveLength(1);
    expect(result.pack.scenarios[0]?.title).toBe("Good");
  });

  it("treats title matches case- and whitespace-insensitively", async () => {
    await writeFeature("login   works");
    const fetchFn = buildFetchFn({ linked: [{ key: "TEST-1", summary: "Login Works" }] });
    const { jira, xray } = clients(fetchFn);

    const result = await buildTestDesignFromXray({ ticketKey: "FINT-1", repoRoot, jira, xray });

    expect(result.kind).toBe("nothing-to-do");
    expect(result.summary.alreadyImplemented).toBe(1);
  });
});
