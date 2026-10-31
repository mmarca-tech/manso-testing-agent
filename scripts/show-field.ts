#!/usr/bin/env node
/** Diagnostic: print a custom field's raw value on an issue. */
import { AtlassianRestClient } from "../src/integrations/atlassianRest/client.js";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { loadEnv } from "../src/shared/loadEnv.js";

loadEnv();

async function main(): Promise<void> {
  const key = process.argv[2] ?? "DATAEX-520";
  const field = process.argv[3] ?? "customfield_15714";
  const config = await loadRuntimeConfig();
  if (!config.jiraRest) throw new Error("No Jira config in .env");
  const client = new AtlassianRestClient({
    jira: {
      baseUrl: config.jiraRest.jiraUrl,
      username: config.jiraRest.jiraUsername,
      apiToken: config.jiraRest.jiraApiToken,
    },
  });
  const issue = (await client.getJson("jira", `/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: field })) as any;
  console.log(`${key}.${field} =`, JSON.stringify(issue?.fields?.[field], null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
