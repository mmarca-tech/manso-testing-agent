import { describe, expect, it, vi } from "vitest";
import { AtlassianRestClient } from "../src/integrations/atlassianRest/client.js";
import { XrayCloudClient } from "../src/integrations/xray/client.js";
import {
  applyTestDesignToXray,
  renderScenarioGherkin,
} from "../src/integrations/xray/testDesignSink.js";
import type { GherkinScenario, PlainEnglishScenario, TestDesignPack } from "../src/domain/testDesignPack/schema.js";

function gherkinScenario(overrides: Partial<GherkinScenario> = {}): GherkinScenario {
  return {
    kind: "gherkin",
    title: "Customer selects an eligible 3-instalment plan",
    feature: "Instalment plan selection",
    tags: ["@instalments", "@smoke"],
    acIds: ["AC-1"],
    risk: "high",
    readiness: "ready",
    objective: "Verify a customer can choose the 3-instalment plan.",
    preconditions: ["The order is eligible"],
    steps: [
      { keyword: "Given", text: "a customer with an approved checkout of 300.00 EUR" },
      { keyword: "When", text: "the customer selects the \"3 instalments\" plan" },
      { keyword: "Then", text: "the plan schedule shows 3 payments of 100.00 EUR" },
    ],
    sourceEvidence: [{ source: "description", reference: "para 1", summary: "Customers should be able to choose a 3-instalment plan." }],
    openQuestions: [],
    rationale: "Direct positive path.",
    ...overrides,
  };
}

function plainEnglishScenario(overrides: Partial<PlainEnglishScenario> = {}): PlainEnglishScenario {
  return {
    kind: "plain-english",
    title: "Tester verifies the instalment schedule manually",
    feature: "Instalment plan selection",
    tags: ["@instalments"],
    acIds: ["AC-1"],
    risk: "medium",
    readiness: "ready",
    objective: "Confirm the schedule shows three equal payments.",
    preconditions: ["The order is eligible"],
    steps: [
      { action: "Open the approved checkout for 300.00 EUR", expectedResult: "The plan options are shown" },
      { action: "Select the \"3 instalments\" plan", expectedResult: "The schedule shows 3 payments of 100.00 EUR" },
    ],
    sourceEvidence: [{ source: "description", reference: "para 1", summary: "Customers should be able to choose a 3-instalment plan." }],
    openQuestions: [],
    rationale: "Manual verification of the schedule.",
    ...overrides,
  };
}

function designPack(scenarios: (GherkinScenario | PlainEnglishScenario)[]): TestDesignPack {
  return {
    schemaVersion: "1.0.0",
    ticket: { key: "ABC-1", title: "Story" },
    outputMode: "gherkin",
    acceptanceCriteria: [{ id: "AC-1", text: "Customer can select a plan.", source: "description" }],
    strategySummary: "Test the plan selection paths.",
    coverageGaps: [],
    scenarios,
    acCoverageMatrix: [{ acId: "AC-1", scenarioIndexes: scenarios.map((_, i) => i) }],
    riskRanking: [{ level: "high", scenarioIndexes: scenarios.map((_, i) => i) }],
    openQuestions: [],
    provenance: {
      generatedAt: "2024-01-01T00:00:00.000Z",
      issueKey: "ABC-1",
      llm: { provider: "anthropic", model: "stub" },
      tools: [],
    },
    warnings: [],
  };
}

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface RouteHandlers {
  xrayAuth?: () => Response;
  xrayGraphql?: (variables: unknown) => Response;
  jiraIssue?: () => Response;
  jiraIssueLink?: (body: unknown) => Response;
  jiraLinkTypes?: () => Response;
  jiraCreateMeta?: () => Response;
  jiraSearch?: () => Response;
  jiraComment?: (body: unknown) => Response;
}

function buildFetchFn(handlers: RouteHandlers): typeof fetch {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (url: string | URL | Request, init?: RequestInit) => {
    const u = url.toString();
    calls.push({ url: u, init });
    if (u.includes("/api/v2/authenticate")) {
      return (handlers.xrayAuth ?? (() => mockResponse("xray-token-abc")))();
    }
    if (u.includes("/api/v2/graphql")) {
      const variables = init?.body ? JSON.parse(String(init.body)).variables : undefined;
      return (handlers.xrayGraphql ??
        (() => mockResponse({ data: { createTest: { test: { issueId: "10001", jira: { key: "TEST-1" } }, warnings: [] } } })))(variables);
    }
    if (u.includes("/rest/api/3/issueLinkType")) {
      return (handlers.jiraLinkTypes ?? (() => mockResponse({ issueLinkTypes: [] })))();
    }
    if (u.includes("/rest/api/3/issueLink")) {
      return (handlers.jiraIssueLink ?? (() => mockResponse({}, 201)))(init?.body ? JSON.parse(String(init.body)) : undefined);
    }
    if (u.includes("/rest/api/3/search/jql")) {
      return (handlers.jiraSearch ?? (() => mockResponse({ issues: [] })))();
    }
    if (u.includes("/comment")) {
      return (handlers.jiraComment ?? (() => mockResponse({ id: "1" }, 201)))(init?.body ? JSON.parse(String(init.body)) : undefined);
    }
    if (u.includes("/rest/api/3/issue/createmeta")) {
      return (handlers.jiraCreateMeta ?? (() => mockResponse({ projects: [] })))();
    }
    if (u.includes("/rest/api/3/issue/")) {
      return (handlers.jiraIssue ?? (() => mockResponse({ fields: { issuelinks: [] } })))();
    }
    return mockResponse({ error: `unhandled: ${u}` }, 500);
  });
  (fetchFn as unknown as { __calls: typeof calls }).__calls = calls;
  return fetchFn;
}

function getCalls(fetchFn: typeof fetch): { url: string; init: RequestInit | undefined }[] {
  return (fetchFn as unknown as { __calls: { url: string; init: RequestInit | undefined }[] }).__calls;
}

describe("renderScenarioGherkin", () => {
  it("emits tags, scenario title, and steps", () => {
    const output = renderScenarioGherkin(gherkinScenario());
    expect(output).toContain("@instalments @smoke");
    expect(output).toContain("Scenario: Customer selects an eligible 3-instalment plan");
    expect(output).toContain("Given a customer with an approved checkout of 300.00 EUR");
  });

  it("uses Scenario Outline + Examples when present", () => {
    const output = renderScenarioGherkin(
      gherkinScenario({
        examples: {
          headers: ["amount", "plan"],
          rows: [["30.00", "hidden"], ["300.00", "visible"]],
        },
      }),
    );
    expect(output).toContain("Scenario Outline:");
    expect(output).toContain("| amount | plan |");
    expect(output).toContain("| 30.00 | hidden |");
  });
});

describe("applyTestDesignToXray", () => {
  it("creates one Cucumber test per scenario and links each to the ticket", async () => {
    const fetchFn = buildFetchFn({});
    const xray = new XrayCloudClient({
      baseUrl: "https://xray.cloud.getxray.app",
      clientId: "id",
      clientSecret: "secret",
      fetchFn,
    });
    const jira = new AtlassianRestClient({
      jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" },
      fetchFn,
    });

    const application = await applyTestDesignToXray({
      testDesign: designPack([gherkinScenario()]),
      ticketKey: "ABC-1",
      projectKey: "ABC",
      xray,
      jira,
    });

    expect(application.status).toBe("applied");
    expect(application.tests).toHaveLength(1);
    expect(application.tests[0]?.status).toBe("created");
    expect(application.tests[0]?.key).toBe("TEST-1");

    const calls = getCalls(fetchFn);
    expect(calls.some((call) => call.url.includes("/api/v2/graphql"))).toBe(true);
    expect(calls.some((call) => call.url.includes("/rest/api/3/issueLink"))).toBe(true);
  });

  it("resolves an 'is tested by' relationship so the STORY displays it (test is the inward issue)", async () => {
    let linkBody: { type?: { name?: string }; inwardIssue?: { key?: string }; outwardIssue?: { key?: string } } | undefined;
    const fetchFn = buildFetchFn({
      jiraLinkTypes: () =>
        mockResponse({
          issueLinkTypes: [
            { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
            { id: "10100", name: "Test", inward: "is tested by", outward: "tests" },
          ],
        }),
      jiraIssueLink: (body) => {
        linkBody = body as typeof linkBody;
        return mockResponse({}, 201);
      },
    });
    const xray = new XrayCloudClient({ baseUrl: "https://xray.cloud.getxray.app", clientId: "id", clientSecret: "secret", fetchFn });
    const jira = new AtlassianRestClient({
      jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" },
      fetchFn,
    });

    await applyTestDesignToXray({
      testDesign: designPack([gherkinScenario()]),
      ticketKey: "ABC-1",
      projectKey: "ABC",
      xray,
      jira,
      linkTypeName: "is tested by",
    });

    // The configured phrase matched the "Test" type's inward description. To
    // make the STORY display "is tested by", the TEST must be the inwardIssue
    // and the story the outwardIssue (Jira labels a link by the side the other
    // issue sits on).
    expect(linkBody?.type?.name).toBe("Test");
    expect(linkBody?.inwardIssue?.key).toBe("TEST-1");
    expect(linkBody?.outwardIssue?.key).toBe("ABC-1");
  });

  it("skips a scenario whose title already exists as a linked Test", async () => {
    const fetchFn = buildFetchFn({
      jiraIssue: () =>
        mockResponse({
          fields: {
            issuelinks: [
              {
                type: { name: "Tests" },
                outwardIssue: {
                  key: "TEST-OLD",
                  fields: {
                    summary: "Customer selects an eligible 3-instalment plan",
                    issuetype: { name: "Test" },
                  },
                },
              },
            ],
          },
        }),
    });
    const xray = new XrayCloudClient({
      baseUrl: "https://xray.cloud.getxray.app",
      clientId: "id",
      clientSecret: "secret",
      fetchFn,
    });
    const jira = new AtlassianRestClient({
      jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" },
      fetchFn,
    });

    const application = await applyTestDesignToXray({
      testDesign: designPack([gherkinScenario()]),
      ticketKey: "ABC-1",
      projectKey: "ABC",
      xray,
      jira,
    });

    expect(application.tests[0]?.status).toBe("skipped-existing");
    const calls = getCalls(fetchFn);
    expect(calls.some((call) => call.url.includes("/api/v2/graphql"))).toBe(false);
  });

  it("skips a scenario whose title matches a linked Test up to case/punctuation (normalized dedup)", async () => {
    const fetchFn = buildFetchFn({
      jiraIssue: () =>
        mockResponse({
          fields: {
            issuelinks: [
              {
                type: { name: "Tests" },
                outwardIssue: {
                  key: "TEST-OLD",
                  // Trailing period + different casing + unicode dash — the
                  // exact-title check used to let this through.
                  fields: { summary: "Customer selects an eligible 3‑instalment Plan.", issuetype: { name: "Test Case" } },
                },
              },
            ],
          },
        }),
    });
    const xray = new XrayCloudClient({ baseUrl: "https://xray.cloud.getxray.app", clientId: "id", clientSecret: "secret", fetchFn });
    const jira = new AtlassianRestClient({ jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" }, fetchFn });

    const application = await applyTestDesignToXray({
      testDesign: designPack([gherkinScenario()]),
      ticketKey: "ABC-1",
      projectKey: "ABC",
      xray,
      jira,
    });

    expect(application.tests[0]?.status).toBe("skipped-existing");
    expect(getCalls(fetchFn).some((call) => call.url.includes("/api/v2/graphql"))).toBe(false);
  });

  it("creates only one test when two scenarios in the same design normalize to the same title", async () => {
    const fetchFn = buildFetchFn({});
    const xray = new XrayCloudClient({ baseUrl: "https://xray.cloud.getxray.app", clientId: "id", clientSecret: "secret", fetchFn });
    const jira = new AtlassianRestClient({ jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" }, fetchFn });

    const application = await applyTestDesignToXray({
      testDesign: designPack([
        gherkinScenario({ title: "Notifications page — 12-month boundary" }),
        gherkinScenario({ title: "Notifications page 12 month boundary." }),
      ]),
      ticketKey: "ABC-1",
      projectKey: "ABC",
      xray,
      jira,
    });

    expect(application.tests[0]?.status).toBe("created");
    expect(application.tests[1]?.status).toBe("skipped-existing");
    expect(application.tests[1]?.message).toContain("Duplicate of another scenario");
  });

  it("retries WITHOUT reporter when Jira rejects the reporter field (MPORTAL live failure)", async () => {
    // Observed live (build 752394): every create failed with
    // "reporter: Field 'reporter' cannot be set..." — attribution must not
    // sink the upload.
    let createCalls = 0;
    const reporterSent: boolean[] = [];
    const fetchFn = buildFetchFn({
      xrayGraphql: (variables: unknown) => {
        const fields = (variables as { jira?: { fields?: Record<string, unknown> } } | undefined)?.jira?.fields;
        createCalls += 1;
        reporterSent.push(Boolean(fields && "reporter" in fields));
        if (fields && "reporter" in fields) {
          return mockResponse({
            errors: [{ message: "Create issue failed! - reporter: Field 'reporter' cannot be set. It is not on the appropriate screen, or unknown." }],
          });
        }
        return mockResponse({ data: { createTest: { test: { issueId: "10001", jira: { key: "TEST-9" } }, warnings: [] } } });
      },
    });
    const xray = new XrayCloudClient({ baseUrl: "https://xray.cloud.getxray.app", clientId: "id", clientSecret: "secret", fetchFn });
    const jira = new AtlassianRestClient({ jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" }, fetchFn });

    const application = await applyTestDesignToXray({
      testDesign: designPack([gherkinScenario(), gherkinScenario({ title: "Second scenario keeps working" })]),
      ticketKey: "ABC-1",
      projectKey: "ABC",
      xray,
      jira,
      additionalFields: { customfield_15714: 170, reporter: { id: "6352c68813f37118d7258d34" } },
    });

    // First create fails with reporter, retry + second scenario go without it.
    expect(reporterSent).toEqual([true, false, false]);
    expect(createCalls).toBe(3);
    expect(application.tests.map((t) => t.status)).toEqual(["created", "created"]);
    expect(application.warnings.some((w) => w.message.includes("Modify Reporter"))).toBe(true);
  });

  it("M26: skips a scenario semantically covered by an existing linked test", async () => {
    // The design reworded an existing test rather than reproducing its title —
    // exact-normalized matching misses it; the semantic pass catches it.
    const fetchFn = buildFetchFn({
      jiraIssue: () =>
        mockResponse({
          fields: {
            issuelinks: [
              {
                type: { name: "Tests" },
                outwardIssue: {
                  key: "TEST-100",
                  fields: {
                    summary: "Customer selects an eligible 3 instalment plan for checkout",
                    issuetype: { name: "Test Case" },
                  },
                },
              },
            ],
          },
        }),
      jiraSearch: () => mockResponse({ issues: [{ key: "TEST-100" }] }),
    });
    const xray = new XrayCloudClient({ baseUrl: "https://xray.cloud.getxray.app", clientId: "id", clientSecret: "secret", fetchFn });
    const jira = new AtlassianRestClient({ jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" }, fetchFn });

    const application = await applyTestDesignToXray({
      testDesign: designPack([gherkinScenario()]),
      ticketKey: "ABC-1",
      projectKey: "ABC",
      xray,
      jira,
    });

    expect(application.tests[0]?.status).toBe("skipped-existing");
    expect(application.tests[0]?.message).toContain("Semantically matches linked test TEST-100");
    expect(application.revision?.kept).toHaveLength(1);
    expect(application.revision?.retireCandidates).toEqual([]);
    // Nothing was created: no Xray GraphQL mutation, no new issue link.
    expect(getCalls(fetchFn).some((c) => c.url.includes("/api/v2/graphql"))).toBe(false);
    // No link creation (note: /issueLinkType is the link-type LOOKUP, not a create).
    expect(getCalls(fetchFn).some((c) => /\/rest\/api\/3\/issueLink$/.test(c.url))).toBe(false);
  });

  it("M26: reports an uncovered manso test as a retire candidate and comments", async () => {
    let commentBody: unknown;
    const fetchFn = buildFetchFn({
      jiraIssue: () =>
        mockResponse({
          fields: {
            issuelinks: [
              {
                type: { name: "Tests" },
                outwardIssue: {
                  key: "TEST-200",
                  fields: { summary: "Legacy behaviour nobody designs for anymore", issuetype: { name: "Test Case" } },
                },
              },
            ],
          },
        }),
      jiraSearch: () => mockResponse({ issues: [{ key: "TEST-200" }] }),
      jiraComment: (body) => {
        commentBody = body;
        return mockResponse({ id: "1" }, 201);
      },
    });
    const xray = new XrayCloudClient({ baseUrl: "https://xray.cloud.getxray.app", clientId: "id", clientSecret: "secret", fetchFn });
    const jira = new AtlassianRestClient({ jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" }, fetchFn });

    const application = await applyTestDesignToXray({
      testDesign: designPack([gherkinScenario()]),
      ticketKey: "ABC-1",
      projectKey: "ABC",
      xray,
      jira,
    });

    expect(application.tests[0]?.status).toBe("created"); // unrelated → still created
    expect(application.revision?.retireCandidates).toEqual([
      { key: "TEST-200", title: "Legacy behaviour nobody designs for anymore" },
    ]);
    expect(JSON.stringify(commentBody)).toContain("Possibly obsolete");
    expect(JSON.stringify(commentBody)).toContain("TEST-200");
  });

  it("M26: never proposes a HAND-WRITTEN linked test for retirement", async () => {
    // Same as above, but the search returns no manso-labelled issues, so
    // the uncovered test is a human's — it must not be reported.
    const fetchFn = buildFetchFn({
      jiraIssue: () =>
        mockResponse({
          fields: {
            issuelinks: [
              {
                type: { name: "Tests" },
                outwardIssue: {
                  key: "TEST-300",
                  fields: { summary: "Hand written exploratory check", issuetype: { name: "Test Case" } },
                },
              },
            ],
          },
        }),
      jiraSearch: () => mockResponse({ issues: [] }),
    });
    const xray = new XrayCloudClient({ baseUrl: "https://xray.cloud.getxray.app", clientId: "id", clientSecret: "secret", fetchFn });
    const jira = new AtlassianRestClient({ jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" }, fetchFn });

    const application = await applyTestDesignToXray({
      testDesign: designPack([gherkinScenario()]),
      ticketKey: "ABC-1",
      projectKey: "ABC",
      xray,
      jira,
    });

    expect(application.revision?.retireCandidates).toEqual([]);
    expect(getCalls(fetchFn).some((c) => c.url.includes("/comment"))).toBe(false);
  });

  it("records a failed status when createTest fails", async () => {
    const fetchFn = buildFetchFn({
      xrayGraphql: () => mockResponse({ errors: [{ message: "boom" }] }),
    });
    const xray = new XrayCloudClient({
      baseUrl: "https://xray.cloud.getxray.app",
      clientId: "id",
      clientSecret: "secret",
      fetchFn,
    });
    const jira = new AtlassianRestClient({
      jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" },
      fetchFn,
    });

    const application = await applyTestDesignToXray({
      testDesign: designPack([gherkinScenario()]),
      ticketKey: "ABC-1",
      projectKey: "ABC",
      xray,
      jira,
    });

    expect(application.tests[0]?.status).toBe("failed");
    expect(application.warnings.length).toBeGreaterThan(0);
  });

  it("dry-run does not call Xray or Jira and returns dry-run status", async () => {
    const fetchFn = buildFetchFn({});
    const xray = new XrayCloudClient({
      baseUrl: "https://xray.cloud.getxray.app",
      clientId: "id",
      clientSecret: "secret",
      fetchFn,
    });
    const jira = new AtlassianRestClient({
      jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" },
      fetchFn,
    });

    const application = await applyTestDesignToXray({
      testDesign: designPack([gherkinScenario(), gherkinScenario({ title: "Second" })]),
      ticketKey: "ABC-1",
      projectKey: "ABC",
      xray,
      jira,
      dryRun: true,
    });

    expect(application.status).toBe("dry-run");
    expect(application.tests).toHaveLength(2);
    expect(getCalls(fetchFn)).toHaveLength(0);
  });
});

describe("applyTestDesignToXray — Manual tests (plain-english)", () => {
  it("creates a Manual test with action/result steps and links it", async () => {
    let vars: any;
    const fetchFn = buildFetchFn({
      xrayGraphql: (v) => {
        vars = v;
        return mockResponse({ data: { createTest: { test: { issueId: "20001", jira: { key: "TEST-M1" } }, warnings: [] } } });
      },
    });
    const xray = new XrayCloudClient({ baseUrl: "https://xray.cloud.getxray.app", clientId: "id", clientSecret: "secret", fetchFn });
    const jira = new AtlassianRestClient({ jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" }, fetchFn });

    const application = await applyTestDesignToXray({
      testDesign: designPack([plainEnglishScenario()]),
      ticketKey: "ABC-1",
      projectKey: "ABC",
      xray,
      jira,
    });

    expect(application.status).toBe("applied");
    expect(application.tests[0]?.status).toBe("created");
    expect(application.tests[0]?.key).toBe("TEST-M1");
    // Manual test type with steps mapped from action/expectedResult → action/result.
    expect(vars.testType).toEqual({ name: "Manual" });
    expect(vars.gherkin).toBeUndefined();
    expect(vars.steps).toEqual([
      { action: "Open the approved checkout for 300.00 EUR", result: "The plan options are shown" },
      { action: "Select the \"3 instalments\" plan", result: "The schedule shows 3 payments of 100.00 EUR" },
    ]);
    expect(getCalls(fetchFn).some((call) => call.url.includes("/rest/api/3/issueLink"))).toBe(true);
  });

  it("creates a Cucumber test and a Manual test for a mixed pack", async () => {
    const testTypes: unknown[] = [];
    const fetchFn = buildFetchFn({
      xrayGraphql: (v) => {
        testTypes.push((v as any).testType);
        const n = testTypes.length;
        return mockResponse({ data: { createTest: { test: { issueId: `3000${n}`, jira: { key: `TEST-${n}` } }, warnings: [] } } });
      },
    });
    const xray = new XrayCloudClient({ baseUrl: "https://xray.cloud.getxray.app", clientId: "id", clientSecret: "secret", fetchFn });
    const jira = new AtlassianRestClient({ jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" }, fetchFn });

    const application = await applyTestDesignToXray({
      testDesign: designPack([gherkinScenario(), plainEnglishScenario()]),
      ticketKey: "ABC-1",
      projectKey: "ABC",
      xray,
      jira,
    });

    expect(application.tests.map((t) => t.status)).toEqual(["created", "created"]);
    expect(testTypes).toEqual([{ name: "Cucumber" }, { name: "Manual" }]);
  });
});

describe("applyTestDesignToXray — project-mandatory fields", () => {
  const createMeta = () =>
    mockResponse({
      projects: [
        {
          issuetypes: [
            { name: "Test", fields: { summary: { required: true }, customfield_15714: { required: true, name: "Account" } } },
          ],
        },
      ],
    });
  const xrayCreate = (capture: { vars?: any }) => (vars: unknown) => {
    capture.vars = vars;
    return mockResponse({ data: { createTest: { test: { issueId: "1", jira: { key: "T-1" } }, warnings: [] } } });
  };
  const clients = (fetchFn: typeof fetch) => ({
    xray: new XrayCloudClient({ baseUrl: "https://xray.cloud.getxray.app", clientId: "id", clientSecret: "s", fetchFn }),
    jira: new AtlassianRestClient({ jira: { baseUrl: "https://example.atlassian.net", username: "u", apiToken: "t" }, fetchFn }),
  });

  it("inherits a required PRIMITIVE field from the source story onto created tests", async () => {
    const cap: { vars?: any } = {};
    const fetchFn = buildFetchFn({
      jiraCreateMeta: createMeta,
      jiraIssue: () => mockResponse({ fields: { issuelinks: [], customfield_15714: 170 } }),
      xrayGraphql: xrayCreate(cap),
    });
    const { xray, jira } = clients(fetchFn);

    const app = await applyTestDesignToXray({ testDesign: designPack([gherkinScenario()]), ticketKey: "ABC-1", projectKey: "ABC", xray, jira });

    expect(app.tests[0]?.status).toBe("created");
    expect(cap.vars.jira.fields.customfield_15714).toBe(170);
    // summary is denylisted — set by us, never inherited from the story field meta.
    expect(cap.vars.jira.fields.summary).toBe("Customer selects an eligible 3-instalment plan");
  });

  it("does NOT inherit a structured (object) required field — warns to use the override instead", async () => {
    const cap: { vars?: any } = {};
    const fetchFn = buildFetchFn({
      jiraCreateMeta: createMeta,
      jiraIssue: () => mockResponse({ fields: { issuelinks: [], customfield_15714: { id: 170, value: "T_Exp Change" } } }),
      xrayGraphql: xrayCreate(cap),
    });
    const { xray, jira } = clients(fetchFn);

    const app = await applyTestDesignToXray({ testDesign: designPack([gherkinScenario()]), ticketKey: "ABC-1", projectKey: "ABC", xray, jira });

    expect(cap.vars.jira.fields.customfield_15714).toBeUndefined();
    expect(app.warnings.some((w) => w.message.includes("xray.testFields") && w.message.includes("170"))).toBe(true);
  });

  it("lets an explicit additionalFields override win over the inherited value", async () => {
    const cap: { vars?: any } = {};
    const fetchFn = buildFetchFn({
      jiraCreateMeta: createMeta,
      jiraIssue: () => mockResponse({ fields: { issuelinks: [], customfield_15714: 170 } }),
      xrayGraphql: xrayCreate(cap),
    });
    const { xray, jira } = clients(fetchFn);

    await applyTestDesignToXray({
      testDesign: designPack([gherkinScenario()]),
      ticketKey: "ABC-1",
      projectKey: "ABC",
      xray,
      jira,
      additionalFields: { customfield_15714: 999 },
    });

    expect(cap.vars.jira.fields.customfield_15714).toBe(999);
  });

  it("skips inheritance (no createmeta) when inheritRequiredFields is false", async () => {
    const cap: { vars?: any } = {};
    let createmetaCalled = false;
    const fetchFn = buildFetchFn({
      jiraCreateMeta: () => { createmetaCalled = true; return createMeta(); },
      xrayGraphql: xrayCreate(cap),
    });
    const { xray, jira } = clients(fetchFn);

    await applyTestDesignToXray({
      testDesign: designPack([gherkinScenario()]),
      ticketKey: "ABC-1",
      projectKey: "ABC",
      xray,
      jira,
      inheritRequiredFields: false,
    });

    expect(createmetaCalled).toBe(false);
    expect(cap.vars.jira.fields.customfield_15714).toBeUndefined();
  });
});
