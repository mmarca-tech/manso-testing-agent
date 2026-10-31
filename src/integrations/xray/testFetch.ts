import type { Warning } from "../../domain/contextPack/schema.js";
import { firstPresent, firstString, isRecord } from "../../shared/utils.js";
import type { AtlassianRestClient } from "../atlassianRest/client.js";
import type { XrayCloudClient } from "./client.js";

export interface LinkedCucumberTest {
  /** Xray test issue key, e.g. "FINT-1069". */
  key: string;
  /** Test summary (title). */
  summary: string;
  /** Raw Gherkin body of the Cucumber test. */
  gherkin: string;
  /** Xray test type name (expected "Cucumber"). */
  testType?: string;
}

export interface FetchLinkedCucumberTestsInput {
  jira: AtlassianRestClient;
  xray: XrayCloudClient;
  /** Story key whose linked tests we want (e.g. "FINT-1056"). */
  ticketKey: string;
  onProgress?: (message: string) => void;
}

export interface FetchLinkedCucumberTestsResult {
  tests: LinkedCucumberTest[];
  warnings: Warning[];
}

const GET_LINKED_TESTS_QUERY = `
query GetLinkedTests($jql: String!, $limit: Int!) {
  getTests(jql: $jql, limit: $limit) {
    results {
      issueId
      jira(fields: ["key", "summary"])
      testType { name }
      gherkin
    }
  }
}
`.trim();

/**
 * Fetch a story's linked **Cucumber** tests together with their Gherkin bodies.
 *
 * Two steps: (1) read the story's Jira issue links to find linked Test issue
 * keys (same pattern as the sink's `listLinkedTestSummaries`), then (2) ask
 * Xray for those tests' `gherkin` via a `getTests` JQL query. Non-Cucumber
 * tests, and tests with an empty Gherkin body, are skipped with a warning.
 */
export async function fetchLinkedCucumberTests(
  input: FetchLinkedCucumberTestsInput,
): Promise<FetchLinkedCucumberTestsResult> {
  const warnings: Warning[] = [];

  const linked = await listLinkedTestKeys(input.jira, input.ticketKey);
  if (linked.size === 0) {
    input.onProgress?.(`No linked Test issues found on ${input.ticketKey}.`);
    return { tests: [], warnings };
  }
  input.onProgress?.(`Found ${linked.size} linked Test issue(s) on ${input.ticketKey}; fetching Gherkin from Xray.`);

  const keys = [...linked.keys()];
  const jql = `issue in (${keys.join(", ")})`;
  let response: unknown;
  try {
    response = await input.xray.graphql(GET_LINKED_TESTS_QUERY, {
      jql,
      limit: Math.max(100, keys.length),
    });
  } catch (error) {
    warnings.push({
      section: "xrayFetch",
      toolName: "xray:getTests",
      message: `Failed to fetch test definitions from Xray for ${input.ticketKey}: ${errorMessage(error)}`,
    });
    return { tests: [], warnings };
  }

  const results = firstPresent(response, ["data.getTests.results", "getTests.results"]);
  const rows = Array.isArray(results) ? results : [];

  const tests: LinkedCucumberTest[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const key = firstString(row, ["jira.key", "key"]);
    if (!key) continue;
    seen.add(key);
    const testType = firstString(row, ["testType.name"]);
    const summary = firstString(row, ["jira.summary"]) ?? linked.get(key) ?? key;
    const gherkin = firstString(row, ["gherkin"]);

    if (testType && testType.toLowerCase() !== "cucumber") {
      warnings.push({
        section: "xrayFetch",
        toolName: "xray:getTests",
        message: `Skipping ${key} — not a Cucumber test (type "${testType}"); only Cucumber tests can be implemented from Gherkin.`,
      });
      continue;
    }
    if (!gherkin) {
      warnings.push({
        section: "xrayFetch",
        toolName: "xray:getTests",
        message: `Skipping ${key} ("${summary}") — Xray returned no Gherkin body.`,
      });
      continue;
    }

    tests.push({ key, summary, gherkin, ...(testType ? { testType } : {}) });
  }

  // Linked Test issues that Xray did not return (e.g. deleted, or a Test issue
  // type Xray doesn't manage) — surface them rather than silently dropping.
  for (const [key, summary] of linked) {
    if (!seen.has(key)) {
      warnings.push({
        section: "xrayFetch",
        toolName: "xray:getTests",
        message: `Linked Test ${key} ("${summary}") was not returned by Xray getTests; skipped.`,
      });
    }
  }

  return { tests, warnings };
}

/** Map of linked Test issue key → its Jira summary, from the story's issue links. */
async function listLinkedTestKeys(
  jira: AtlassianRestClient,
  ticketKey: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const response = await jira.getJson("jira", `/rest/api/3/issue/${encodeURIComponent(ticketKey)}`, {
    fields: "issuelinks",
  });
  const links = firstPresent(response, ["fields.issuelinks", "issuelinks"]);
  if (!Array.isArray(links)) {
    return out;
  }
  for (const link of links) {
    if (!isRecord(link)) continue;
    for (const side of ["inwardIssue", "outwardIssue"] as const) {
      const issue = link[side];
      if (!isRecord(issue)) continue;
      // Xray test issues are typed "Test" in some instances and "Test Case" in
      // others — match any test-like issue type. (Xray's getTests filters the
      // final list to actual Cucumber tests anyway.)
      const issueType = (firstString(issue, ["fields.issuetype.name", "issuetype.name"]) ?? "").toLowerCase();
      if (!issueType.includes("test")) continue;
      const key = firstString(issue, ["key"]);
      if (!key) continue;
      const summary = firstString(issue, ["fields.summary", "summary"]) ?? key;
      out.set(key, summary);
    }
  }
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
