import { AzureDevOpsAdapter, detectAzureDevOpsRemote } from "./azureDevOpsAdapter.js";
import { GitHubAdapter, detectGitHubRemote } from "./githubAdapter.js";
import type { VcsAdapter, VcsAdapterKind } from "./adapter.js";
import type { GitPushAuth } from "../git/branchCommit.js";

/**
 * Provider-neutral VCS resolution (M17). Detects whether a repo's `origin`
 * points at Azure DevOps or GitHub and builds the matching {@link VcsAdapter}
 * using the right token. Keeps the CLIs from hard-coding one platform.
 */

export interface VcsTokens {
  azureDevOpsToken?: string;
  githubToken?: string;
}

export type VcsResolution =
  | { ok: true; adapter: VcsAdapter; kind: VcsAdapterKind; description: string }
  | { ok: false; reason: string };

/**
 * Detect the remote platform for `repoRoot` and build its adapter. Returns a
 * structured failure (rather than throwing) so callers can choose to error out
 * (e.g. `implement-tests --pr`) or skip softly (e.g. `@update-agent`).
 */
export async function resolveVcsAdapter(repoRoot: string, tokens: VcsTokens): Promise<VcsResolution> {
  const azure = await detectAzureDevOpsRemote(repoRoot);
  if (azure) {
    if (!tokens.azureDevOpsToken) {
      return { ok: false, reason: "Azure DevOps remote detected but AZURE_DEVOPS_PAT is not set." };
    }
    return {
      ok: true,
      kind: "azure-devops",
      description: `${azure.organization}/${azure.project}/${azure.repository}`,
      adapter: new AzureDevOpsAdapter({
        organization: azure.organization,
        project: azure.project,
        repository: azure.repository,
        pat: tokens.azureDevOpsToken,
        baseUrl: azure.baseUrl,
      }),
    };
  }

  const github = await detectGitHubRemote(repoRoot);
  if (github) {
    if (!tokens.githubToken) {
      return { ok: false, reason: "GitHub remote detected but GITHUB_TOKEN is not set." };
    }
    return {
      ok: true,
      kind: "github",
      description: `${github.owner}/${github.repo}`,
      adapter: new GitHubAdapter({
        owner: github.owner,
        repo: github.repo,
        token: tokens.githubToken,
        apiBaseUrl: github.apiBaseUrl,
      }),
    };
  }

  return { ok: false, reason: `No supported VCS remote (Azure DevOps or GitHub) detected in ${repoRoot}.` };
}

/**
 * Resolve token-based `git push` auth for `repoRoot`'s remote, for unattended
 * (pipeline) runs. Returns an {@link GitPushAuth} header when the remote is
 * recognised *and* a token is available; otherwise `undefined`, which makes the
 * push fall back to the host's local git credentials.
 *
 * Never throws — a missing token is a soft fallback, not an error, so a local
 * developer with cached credentials is unaffected.
 *
 * GitHub uses HTTP Basic with the token as the password (`x-access-token` user),
 * the canonical scheme for github.com and GitHub Enterprise. Azure DevOps uses
 * Basic with an empty user and the PAT as the password.
 */
export async function resolveGitPushAuth(
  repoRoot: string,
  tokens: VcsTokens,
): Promise<GitPushAuth | undefined> {
  const github = await detectGitHubRemote(repoRoot);
  if (github && tokens.githubToken) {
    const basic = Buffer.from(`x-access-token:${tokens.githubToken}`).toString("base64");
    return { extraHeader: `Authorization: Basic ${basic}`, description: "github (token)" };
  }

  const azure = await detectAzureDevOpsRemote(repoRoot);
  if (azure && tokens.azureDevOpsToken) {
    const basic = Buffer.from(`:${tokens.azureDevOpsToken}`).toString("base64");
    return { extraHeader: `Authorization: Basic ${basic}`, description: "azure-devops (PAT)" };
  }

  return undefined;
}

/** Tokens helper from a RuntimeConfig-shaped object. */
export function vcsTokensFromRuntime(runtime: {
  azureDevOps?: { token: string };
  github?: { token: string };
}): VcsTokens {
  return {
    ...(runtime.azureDevOps?.token ? { azureDevOpsToken: runtime.azureDevOps.token } : {}),
    ...(runtime.github?.token ? { githubToken: runtime.github.token } : {}),
  };
}
