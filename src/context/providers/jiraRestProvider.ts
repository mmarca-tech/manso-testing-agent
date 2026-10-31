import type { RuntimeConfig } from "../../config/runtimeConfig.js";
import { AtlassianRestClient, type AtlassianRestCredentials } from "../../integrations/atlassianRest/client.js";
import { AtlassianRestSource } from "../../integrations/atlassianRest/source.js";
import type { ContextProvider } from "../providerRegistry.js";

export interface JiraRestProviderOptions {
  jira: AtlassianRestCredentials;
  confluence?: AtlassianRestCredentials;
  jiraCloudId?: string;
  /** Override for `fetch`, primarily for tests. */
  fetchFn?: typeof fetch;
}

/**
 * Build a {@link ContextProvider} backed by Jira and (optionally) Confluence
 * REST APIs. Thin wrapper around {@link AtlassianRestSource} that exposes it
 * through the provider seam.
 */
export function createJiraRestProvider(options: JiraRestProviderOptions): ContextProvider {
  const client = new AtlassianRestClient({
    jira: options.jira,
    ...(options.confluence ? { confluence: options.confluence } : {}),
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  });

  return new AtlassianRestSource({
    client,
    ...(options.jiraCloudId ? { jiraCloudId: options.jiraCloudId } : {}),
  });
}

/**
 * Convenience: build a {@link ContextProvider} from a resolved
 * {@link RuntimeConfig}. Returns `undefined` when Jira credentials are missing
 * so the caller can decide whether that is an error.
 */
export function createJiraRestProviderFromRuntime(
  runtime: Pick<RuntimeConfig, "jiraRest">,
  fetchFn?: typeof fetch,
): ContextProvider | undefined {
  const { jiraRest } = runtime;
  if (!jiraRest) {
    return undefined;
  }

  return createJiraRestProvider({
    jira: {
      baseUrl: jiraRest.jiraUrl,
      username: jiraRest.jiraUsername,
      apiToken: jiraRest.jiraApiToken,
    },
    ...(jiraRest.confluenceUrl && jiraRest.confluenceUsername && jiraRest.confluenceApiToken
      ? {
          confluence: {
            baseUrl: jiraRest.confluenceUrl,
            username: jiraRest.confluenceUsername,
            apiToken: jiraRest.confluenceApiToken,
          },
        }
      : {}),
    ...(jiraRest.jiraCloudId ? { jiraCloudId: jiraRest.jiraCloudId } : {}),
    ...(fetchFn ? { fetchFn } : {}),
  });
}
