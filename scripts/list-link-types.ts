#!/usr/bin/env node
/**
 * List the Jira issue link types available in the configured instance, so you
 * can set XRAY_TEST_LINK_TYPE to the exact name that represents test coverage.
 *
 * Run with:  npx tsx scripts/list-link-types.ts
 */
import { AtlassianRestClient } from "../src/integrations/atlassianRest/client.js";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { loadEnv } from "../src/shared/loadEnv.js";

loadEnv();

interface IssueLinkType {
  id: string;
  name: string;
  inward: string;
  outward: string;
}

async function main(): Promise<void> {
  const config = await loadRuntimeConfig();
  if (!config.jiraRest) {
    console.error("No Jira config. Check JIRA_URL / JIRA_USERNAME / JIRA_API_TOKEN in .env.");
    process.exit(1);
  }

  const client = new AtlassianRestClient({
    jira: {
      baseUrl: config.jiraRest.jiraUrl,
      username: config.jiraRest.jiraUsername,
      apiToken: config.jiraRest.jiraApiToken,
    },
  });

  const response = (await client.getJson("jira", "/rest/api/3/issueLinkType")) as {
    issueLinkTypes?: IssueLinkType[];
  };
  const types = response.issueLinkTypes ?? [];

  console.log(`Found ${types.length} issue link type(s):\n`);
  for (const type of types) {
    console.log(`  name: "${type.name}"    outward: "${type.outward}"    inward: "${type.inward}"`);
  }
  console.log(
    "\nSet XRAY_TEST_LINK_TYPE to the exact `name` whose direction expresses test coverage",
  );
  console.log('(commonly "Test" with outward "tests" / inward "is tested by").');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
