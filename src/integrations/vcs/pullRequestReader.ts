import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import type { AzureDevOpsAdapterOptions } from "./azureDevOpsAdapter.js";
import type { GitHubAdapterOptions } from "./githubAdapter.js";
import type { VcsChangedFile, VcsInlineCommentLocation, VcsPullRequest, VcsPullRequestDiff } from "./adapter.js";

const MAX_FILES = 1000;
const MAX_PATCH_FILES = 40;
const MAX_FILE_CHARS = 200_000;
const Commit = z.object({ commitId: z.string().regex(/^[a-f0-9]{40}$/i) });
const AzurePr = z.object({
  pullRequestId: z.number().int().positive(), title: z.string().min(1),
  description: z.string().optional(), sourceRefName: z.string(), targetRefName: z.string(),
  lastMergeSourceCommit: Commit, lastMergeTargetCommit: Commit,
});
const GitHubPr = z.object({
  number: z.number().int().positive(), title: z.string().min(1), body: z.string().nullable(),
  html_url: z.string().url(), head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string(), sha: z.string() }), changed_files: z.number().int().nonnegative(),
});
const AzureChange = z.object({
  changeType: z.string(),
  sourceServerItem: z.string().optional(),
  item: z.object({ path: z.string(), gitObjectType: z.string(), objectId: z.string().optional() }),
});

function changeType(value: string): VcsChangedFile["changeType"] {
  if (/rename/i.test(value)) return "rename";
  if (/add/i.test(value)) return "add";
  if (/delete|removed/i.test(value)) return "delete";
  if (/edit|modified/i.test(value)) return "edit";
  return "unknown";
}

async function readJson(url: URL, headers: Record<string, string>, fetchFn: typeof fetch): Promise<unknown> {
  const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`PR evidence request failed (${response.status}) at ${url.pathname}.`);
  return response.json();
}

function azureApi(options: AzureDevOpsAdapterOptions) {
  const root = `${options.baseUrl ?? "https://dev.azure.com"}/${encodeURIComponent(options.organization)}/${encodeURIComponent(options.project)}/_apis/git/repositories/${encodeURIComponent(options.repository)}`;
  return {
    url: (suffix: string) => {
      const url = new URL(`${root}${suffix}`);
      url.searchParams.set("api-version", options.apiVersion ?? "7.1");
      return url;
    },
    headers: { Authorization: `Basic ${Buffer.from(`:${options.pat}`).toString("base64")}`, Accept: "application/json" },
    fetchFn: options.fetchFn ?? fetch,
  };
}

/** Fetch Azure PR metadata, including immutable source/target commit IDs. */
export async function readAzurePullRequest(options: AzureDevOpsAdapterOptions, id: number): Promise<VcsPullRequest> {
  const api = azureApi(options);
  const pr = AzurePr.parse(await readJson(api.url(`/pullrequests/${id}`), api.headers, api.fetchFn));
  return {
    id: pr.pullRequestId, title: pr.title,
    ...(pr.description !== undefined ? { description: pr.description } : {}),
    sourceBranch: pr.sourceRefName, targetBranch: pr.targetRefName,
    sourceCommit: pr.lastMergeSourceCommit.commitId, targetCommit: pr.lastMergeTargetCommit.commitId,
    url: `${options.baseUrl ?? "https://dev.azure.com"}/${encodeURIComponent(options.organization)}/${encodeURIComponent(options.project)}/_git/${encodeURIComponent(options.repository)}/pullrequest/${id}`,
  };
}

/** Compare the merge base to the source commit, not merely the latest iteration. */
export async function readAzurePullRequestDiff(options: AzureDevOpsAdapterOptions, id: number): Promise<VcsPullRequestDiff> {
  const api = azureApi(options);
  const pr = await readAzurePullRequest(options, id);
  if (!pr.sourceCommit || !pr.targetCommit) throw new Error("Azure PR source/target commit metadata is missing.");
  const sourceCommit = pr.sourceCommit;
  const targetCommit = pr.targetCommit;
  const changes: z.infer<typeof AzureChange>[] = [];
  let baseCommit = "";
  let complete = false;
  for (let skip = 0; skip < MAX_FILES; skip += 100) {
    const url = api.url("/diffs/commits");
    url.searchParams.set("baseVersion", targetCommit);
    url.searchParams.set("targetVersion", sourceCommit);
    url.searchParams.set("baseVersionType", "commit");
    url.searchParams.set("targetVersionType", "commit");
    url.searchParams.set("diffCommonCommit", "true");
    url.searchParams.set("$top", "100");
    url.searchParams.set("$skip", String(skip));
    const page = z.object({
      commonCommit: z.string().regex(/^[a-f0-9]{40}$/i),
      allChangesIncluded: z.boolean(), changes: z.array(AzureChange),
    }).parse(await readJson(url, api.headers, api.fetchFn));
    baseCommit = page.commonCommit;
    changes.push(...page.changes);
    if (page.allChangesIncluded) { complete = true; break; }
    if (page.changes.length === 0) throw new Error("Azure PR diff pagination stopped before all changes were returned.");
  }
  const warnings: string[] = [];
  if (!complete) warnings.push(`Changed-file list capped at ${MAX_FILES} entries.`);
  const files: VcsChangedFile[] = [];
  for (const change of changes.filter((entry) => entry.item.gitObjectType !== "tree")) {
    const type = changeType(change.changeType);
    const file: VcsChangedFile = { path: change.item.path, changeType: type };
    if (files.length < MAX_PATCH_FILES && type !== "unknown" && change.item.gitObjectType === "blob") {
      const readFile = async (path: string, commit: string): Promise<string | undefined> => {
        const url = api.url("/items");
        url.searchParams.set("path", path);
        url.searchParams.set("versionDescriptor.version", commit);
        url.searchParams.set("versionDescriptor.versionType", "commit");
        const response = await api.fetchFn(url, {
          headers: { ...api.headers, Accept: "text/plain" }, signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`Azure PR source read failed (${response.status}) for ${path}.`);
        const text = await response.text();
        if (text.includes("\0") || text.length > MAX_FILE_CHARS) {
          warnings.push(`No patch for ${path}: binary or larger than ${MAX_FILE_CHARS} characters.`);
          return undefined;
        }
        return text;
      };
      const oldPath = change.sourceServerItem ?? file.path;
      const oldText = type === "add" ? "" : await readFile(oldPath, baseCommit);
      const newText = type === "delete" ? "" : await readFile(file.path, sourceCommit);
      if (oldText !== undefined && newText !== undefined) {
        file.patch = createTwoFilesPatch(oldPath, file.path, oldText, newText, "", "", { context: 3 });
      }
    } else {
      warnings.push(`No patch for ${file.path}: patch limit, non-text Git object, or unsupported change type.`);
    }
    files.push(file);
  }
  return { files, hasPatches: files.every((file) => file.patch !== undefined), allChangesIncluded: complete, warnings };
}

/** Bind an inline thread to the reviewed Azure iteration and tracked file. */
export async function readAzureInlineThreadContext(
  options: AzureDevOpsAdapterOptions,
  pullRequestId: number,
  location: VcsInlineCommentLocation,
): Promise<{ changeTrackingId: number; iterationContext: { firstComparingIteration: number; secondComparingIteration: number } }> {
  const api = azureApi(options);
  const root = `/pullrequests/${pullRequestId}/iterations`;
  const iterations = z.object({ value: z.array(z.object({
    id: z.number().int().positive(), sourceRefCommit: Commit,
  })) }).parse(await readJson(api.url(root), api.headers, api.fetchFn));
  const latest = iterations.value.reduce<(typeof iterations.value)[number] | undefined>(
    (last, candidate) => !last || candidate.id > last.id ? candidate : last, undefined,
  );
  if (!latest || latest.sourceRefCommit.commitId !== location.sourceCommit) {
    throw new Error("Azure PR iteration no longer matches the reviewed source commit; rerun review.");
  }
  const path = `/${location.path.replace(/^\/+/, "")}`;
  for (let skip = 0; skip < MAX_FILES; skip += 100) {
    const url = api.url(`${root}/${latest.id}/changes`);
    url.searchParams.set("$compareTo", "0");
    url.searchParams.set("$top", "100");
    url.searchParams.set("$skip", String(skip));
    const page = z.object({
      changeEntries: z.array(z.object({
        changeTrackingId: z.number().int().positive(), item: z.object({ path: z.string() }),
      })),
      nextSkip: z.number().int().nonnegative().optional(),
    }).parse(await readJson(url, api.headers, api.fetchFn));
    const change = page.changeEntries.find((entry) => entry.item.path === path);
    if (change) {
      return {
        changeTrackingId: change.changeTrackingId,
        iterationContext: { firstComparingIteration: 0, secondComparingIteration: latest.id },
      };
    }
    if (page.nextSkip === 0 || page.changeEntries.length === 0 ||
        (page.nextSkip === undefined && page.changeEntries.length < 100)) break;
  }
  throw new Error(`Azure PR has no tracked diff file for ${path}; inline comment was not posted.`);
}

function githubApi(options: GitHubAdapterOptions) {
  // Preserve the /api/v3 prefix on GitHub Enterprise hosts.
  const root = `${options.apiBaseUrl ?? "https://api.github.com"}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;
  return {
    url: (suffix: string) => new URL(`${root}${suffix}`),
    headers: {
      Authorization: `Bearer ${options.token}`, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": options.apiVersion ?? "2022-11-28", "User-Agent": "manso",
    },
    fetchFn: options.fetchFn ?? fetch,
  };
}

/** Fetch GitHub PR metadata for ticket detection and commit provenance. */
export async function readGitHubPullRequest(options: GitHubAdapterOptions, id: number): Promise<VcsPullRequest> {
  const api = githubApi(options);
  const pr = GitHubPr.parse(await readJson(api.url(`/pulls/${id}`), api.headers, api.fetchFn));
  return {
    id: pr.number, title: pr.title, ...(pr.body !== null ? { description: pr.body } : {}),
    sourceBranch: pr.head.ref, targetBranch: pr.base.ref, sourceCommit: pr.head.sha,
    targetCommit: pr.base.sha, url: pr.html_url,
  };
}

/** Read paginated GitHub patches; never claim complete evidence for missing patches. */
export async function readGitHubPullRequestDiff(options: GitHubAdapterOptions, id: number): Promise<VcsPullRequestDiff> {
  const api = githubApi(options);
  const pr = GitHubPr.parse(await readJson(api.url(`/pulls/${id}`), api.headers, api.fetchFn));
  const files: VcsChangedFile[] = [];
  for (let page = 1; files.length < Math.min(pr.changed_files, MAX_FILES); page++) {
    const url = api.url(`/pulls/${id}/files`);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const entries = z.array(z.object({
      filename: z.string(), status: z.string(), patch: z.string().optional(),
    })).parse(await readJson(url, api.headers, api.fetchFn));
    if (entries.length === 0) break;
    files.push(...entries.map((entry) => ({
      path: entry.filename, changeType: changeType(entry.status),
      ...(entry.patch !== undefined && entry.patch.length <= MAX_FILE_CHARS ? { patch: entry.patch } : {}),
    })));
  }
  const complete = files.length === pr.changed_files;
  const warnings = files.filter((file) => file.patch === undefined).map((file) => `No complete text patch for ${file.path}.`);
  if (!complete) warnings.push(`Only ${files.length} of ${pr.changed_files} changed files were returned.`);
  return { files, hasPatches: files.every((file) => file.patch !== undefined), allChangesIncluded: complete, warnings };
}
