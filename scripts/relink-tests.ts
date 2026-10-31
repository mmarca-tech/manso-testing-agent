#!/usr/bin/env node
/**
 * Repair script: link the Xray tests recorded in a TestDesignPack's
 * `application.tests` to the source ticket, using the link type configured in
 * .env (XRAY_TEST_LINK_TYPE / XRAY_TEST_LINK_DIRECTION).
 *
 * Use this when `design-tests --yes` created the tests but the link step
 * failed (e.g. wrong XRAY_TEST_LINK_TYPE). It is idempotent: tests already
 * linked to the ticket are skipped, so re-running is safe.
 *
 * Run with:  npx tsx scripts/relink-tests.ts --issue QATG-2940 [--out ./out]
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AtlassianRestClient } from "../src/integrations/atlassianRest/client.js";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { loadEnv } from "../src/shared/loadEnv.js";

loadEnv();

interface AppliedTest {
  status: string;
  key?: string;
  title: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      issue: { type: "string" },
      out: { type: "string" },
    },
    allowPositionals: false,
  });

  const issueKey = values.issue;
  if (!issueKey) {
    console.error("Usage: npx tsx scripts/relink-tests.ts --issue <KEY> [--out ./out]");
    process.exit(1);
  }
  const outDir = resolve(values.out ?? "./out");

  const config = await loadRuntimeConfig();
  if (!config.jiraRest) {
    console.error("No Jira config. Check JIRA_URL / JIRA_USERNAME / JIRA_API_TOKEN.");
    process.exit(1);
  }
  const linkTypeName = config.xray?.testIssueLinkType ?? "Test";
  const direction = config.xray?.testIssueLinkDirection ?? "test-to-ticket";
  console.log(`Link type: "${linkTypeName}"   direction: ${direction}`);

  const designPath = join(outDir, issueKey, "test-design.json");
  const pack = JSON.parse(await readFile(designPath, "utf8")) as {
    application?: { tests?: AppliedTest[] };
  };
  const created = (pack.application?.tests ?? []).filter(
    (test): test is AppliedTest & { key: string } => test.status === "created" && typeof test.key === "string",
  );
  if (created.length === 0) {
    console.log("No created tests with keys found in the pack. Nothing to relink.");
    return;
  }
  console.log(`Found ${created.length} created test(s) to link to ${issueKey}.\n`);

  const client = new AtlassianRestClient({
    jira: {
      baseUrl: config.jiraRest.jiraUrl,
      username: config.jiraRest.jiraUsername,
      apiToken: config.jiraRest.jiraApiToken,
    },
  });

  // Collect keys already linked to the ticket so the relink is idempotent.
  const issue = await client.getJson("jira", `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    fields: "issuelinks",
  });
  const linkedKeys = new Set<string>();
  const issuelinks = isRecord(issue) && isRecord(issue.fields) ? issue.fields.issuelinks : undefined;
  if (Array.isArray(issuelinks)) {
    for (const link of issuelinks) {
      if (!isRecord(link)) continue;
      for (const side of ["inwardIssue", "outwardIssue"] as const) {
        const linked = link[side];
        if (isRecord(linked) && typeof linked.key === "string") {
          linkedKeys.add(linked.key);
        }
      }
    }
  }

  let linked = 0;
  let skipped = 0;
  let failed = 0;
  for (const test of created) {
    if (linkedKeys.has(test.key)) {
      console.log(`  [already linked] ${test.key}`);
      skipped += 1;
      continue;
    }
    const body =
      direction === "test-to-ticket"
        ? { type: { name: linkTypeName }, inwardIssue: { key: issueKey }, outwardIssue: { key: test.key } }
        : { type: { name: linkTypeName }, inwardIssue: { key: test.key }, outwardIssue: { key: issueKey } };
    try {
      await client.postJson("jira", "/rest/api/3/issueLink", body);
      console.log(`  [linked] ${test.key} — ${test.title}`);
      linked += 1;
    } catch (error) {
      console.error(`  [failed] ${test.key}: ${error instanceof Error ? error.message : String(error)}`);
      failed += 1;
    }
  }

  console.log(`\nDone: ${linked} linked, ${skipped} already linked, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
