#!/usr/bin/env node
/**
 * One-off remediation: re-orient existing "Test" issue links on a story so the
 * STORY displays "is tested by" (test as inwardIssue, story as outwardIssue).
 * Deletes each wrong-direction link and recreates it correctly. Only touches
 * issue LINKS — never the test issues themselves.
 *
 * Run with:  npx tsx scripts/reorient-links.ts --issue FINT-1056
 */
import { parseArgs } from "node:util";
import { AtlassianRestClient } from "../src/integrations/atlassianRest/client.js";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { loadEnv } from "../src/shared/loadEnv.js";

loadEnv();

function isRecord(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { issue: { type: "string" }, type: { type: "string" } }, allowPositionals: false });
  const issueKey = values.issue;
  const typeName = values.type ?? "Test";
  if (!issueKey) {
    console.error("Usage: npx tsx scripts/reorient-links.ts --issue <KEY> [--type Test]");
    process.exit(1);
  }

  const config = await loadRuntimeConfig();
  if (!config.jiraRest) throw new Error("No Jira config in .env");
  const { jiraUrl, jiraUsername, jiraApiToken } = config.jiraRest;
  const client = new AtlassianRestClient({
    jira: { baseUrl: jiraUrl, username: jiraUsername, apiToken: jiraApiToken },
  });
  const authHeader = `Basic ${Buffer.from(`${jiraUsername}:${jiraApiToken}`).toString("base64")}`;
  const deleteLink = async (linkId: string): Promise<void> => {
    const res = await fetch(new URL(`/rest/api/3/issueLink/${linkId}`, `${jiraUrl}/`), {
      method: "DELETE",
      headers: { Authorization: authHeader, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`DELETE issueLink ${linkId} → ${res.status} ${res.statusText}`);
  };

  const issue = (await client.getJson("jira", `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    fields: "issuelinks",
  })) as any;
  const links: any[] = issue?.fields?.issuelinks ?? [];

  // Wrong orientation = the test sits on the story's OUTWARD side (story shows
  // the outward phrase "tests"). We want the test on the INWARD side.
  const wrong = links.filter(
    (l) => isRecord(l) && l.type?.name === typeName && isRecord(l.outwardIssue),
  );
  console.log(`${issueKey}: ${wrong.length} "${typeName}" link(s) to re-orient.\n`);

  let fixed = 0;
  for (const link of wrong) {
    const testKey = link.outwardIssue.key as string;
    const linkId = link.id as string;
    try {
      await deleteLink(linkId);
      await client.postJson("jira", "/rest/api/3/issueLink", {
        type: { name: typeName },
        inwardIssue: { key: testKey },
        outwardIssue: { key: issueKey },
      });
      console.log(`  [reoriented] ${testKey}  (story now "is tested by" ${testKey})`);
      fixed += 1;
    } catch (error) {
      console.error(`  [failed] ${testKey}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\nDone: ${fixed}/${wrong.length} re-oriented.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
