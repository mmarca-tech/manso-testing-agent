import { parseArgs } from "node:util";
import { loadRuntimeConfig } from "../config/runtimeConfig.js";
import { createJiraRestProviderFromRuntime } from "../context/providers/jiraRestProvider.js";
import { CliError } from "../shared/cli.js";
import type { CommandModule } from "./main.js";

const HELP = `manso fetch - fetch a Jira ticket through the Context Layer.

Usage:
  manso fetch --issue <KEY> [options]

Options:
  --issue <KEY>       Jira issue key (e.g. ABC-123). Required.
  --config <path>     Optional JSON runtime-config file for non-secret overrides.
  --comments          Also fetch issue comments.
  --links             Also fetch linked issues.
  --confluence        Also fetch linked Confluence pages.
  --development       Also fetch dev info (branches, pull requests).
  --all               Fetch every section above.
  -h, --help          Show this help.

Reads Jira credentials from .env or the --config file.
Prints normalized JSON to stdout; provenance and warnings are always included.
`;

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      issue: { type: "string" },
      config: { type: "string" },
      comments: { type: "boolean" },
      links: { type: "boolean" },
      confluence: { type: "boolean" },
      development: { type: "boolean" },
      all: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const issueKey = values.issue;
  if (!issueKey) {
    throw new CliError("--issue is required. Run 'manso fetch --help' for usage.");
  }

  const runtime = await loadRuntimeConfig(values.config ? { configPath: values.config } : {});
  const provider = createJiraRestProviderFromRuntime(runtime);
  if (!provider) {
    throw new CliError(
      "Jira credentials are not configured. Set JIRA_URL, JIRA_USERNAME, and JIRA_API_TOKEN.",
    );
  }

  try {
    const fetchAll = values.all ?? false;
    const result: Record<string, unknown> = {
      sourceName: provider.getSourceName(),
      issue: await provider.getIssue(issueKey),
    };
    if (fetchAll || values.comments) {
      result.comments = await provider.getComments(issueKey);
    }
    if (fetchAll || values.links) {
      result.linkedIssues = await provider.getLinkedIssues(issueKey);
    }
    if (fetchAll || values.confluence) {
      result.confluencePages = await provider.getConfluencePages(issueKey);
    }
    if (fetchAll || values.development) {
      result.development = await provider.getDevelopmentLinks(issueKey);
    }
    result.provenance = provider.getProvenance();
    result.warnings = provider.getWarnings();

    console.log(JSON.stringify(result, null, 2));
    return 0;
  } finally {
    await provider.close();
  }
}

const command: CommandModule = { run };
export default command;
