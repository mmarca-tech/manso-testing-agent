import { runShellCommand } from "../shell/runShellCommand.js";
import { readAzureInlineThreadContext, readAzurePullRequest, readAzurePullRequestDiff } from "./pullRequestReader.js";
import type {
  VcsAdapter,
  VcsCommentThread,
  VcsPostCommentInput,
  VcsPostCommentResult,
  VcsUpdateCommentInput,
  VcsRaisePullRequestInput,
  VcsRaisePullRequestResult,
  VcsPullRequest,
  VcsPullRequestDiff,
} from "./adapter.js";

export interface AzureDevOpsRemote {
  organization: string;
  project: string;
  repository: string;
  /** Detected base URL; defaults to https://dev.azure.com. */
  baseUrl: string;
}

export interface AzureDevOpsAdapterOptions {
  organization: string;
  project: string;
  repository: string;
  /** Personal access token with `Code (Read & Write)` + `Pull Request (Read & Write)`. */
  pat: string;
  /** Override the base URL; defaults to https://dev.azure.com. */
  baseUrl?: string;
  /** Override `fetch`, primarily for tests. */
  fetchFn?: typeof fetch;
  /** REST API version. Defaults to 7.1-preview.1. */
  apiVersion?: string;
}

const DEFAULT_BASE_URL = "https://dev.azure.com";
const DEFAULT_API_VERSION = "7.1-preview.1";

/**
 * VcsAdapter implementation for Azure DevOps Git repositories. Raises a pull
 * request via REST and records the resulting URL.
 *
 * Auth: HTTP Basic with empty user + PAT password (Azure's standard pattern).
 */
export class AzureDevOpsAdapter implements VcsAdapter {
  readonly kind = "azure-devops" as const;
  private readonly options: Required<Omit<AzureDevOpsAdapterOptions, "fetchFn">> & {
    fetchFn: typeof fetch;
  };

  constructor(options: AzureDevOpsAdapterOptions) {
    this.options = {
      organization: options.organization,
      project: options.project,
      repository: options.repository,
      pat: options.pat,
      baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
      apiVersion: options.apiVersion ?? DEFAULT_API_VERSION,
      fetchFn: options.fetchFn ?? fetch,
    };
  }

  async raisePullRequest(input: VcsRaisePullRequestInput): Promise<VcsRaisePullRequestResult> {
    if (input.dryRun) {
      return {
        status: "dry-run",
        message: `dry-run: would POST PR from ${input.branch} into ${input.targetBranch} in ${this.options.organization}/${this.options.project}/${this.options.repository}`,
      };
    }

    const url = new URL(
      `/${encodeURIComponent(this.options.organization)}/${encodeURIComponent(this.options.project)}/_apis/git/repositories/${encodeURIComponent(this.options.repository)}/pullrequests`,
      `${this.options.baseUrl}/`,
    );
    url.searchParams.set("api-version", this.options.apiVersion);

    const body = {
      sourceRefName: refName(input.branch),
      targetRefName: refName(input.targetBranch),
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
    };

    let response: Response;
    try {
      response = await this.options.fetchFn(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: basicAuth(this.options.pat),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      return {
        status: "failed",
        message: `Azure DevOps PR create failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (response.status === 409) {
      const message = await safeText(response);
      return {
        status: "exists",
        message: `An active pull request already exists for ${input.branch} → ${input.targetBranch}. Response: ${truncate(message, 500)}`,
      };
    }

    if (!response.ok) {
      const message = await safeText(response);
      return {
        status: "failed",
        message: `Azure DevOps PR create ${response.status} ${response.statusText}: ${truncate(message, 500)}`,
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        status: "failed",
        message: "Azure DevOps PR create returned a non-JSON body.",
      };
    }

    const pullRequestId = extractPullRequestId(payload);
    const prUrl = extractPullRequestUrl(payload, this.options);
    return {
      status: "raised",
      ...(pullRequestId !== undefined ? { pullRequestId } : {}),
      ...(prUrl ? { url: prUrl } : {}),
    };
  }

  async listPullRequestThreads(pullRequestId: number): Promise<VcsCommentThread[]> {
    const url = this.threadsUrl(pullRequestId);
    const response = await this.options.fetchFn(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: basicAuth(this.options.pat),
      },
    });
    if (!response.ok) {
      throw new Error(`Azure DevOps list threads ${response.status} ${response.statusText}: ${truncate(await safeText(response), 500)}`);
    }
    const payload = (await response.json()) as unknown;
    return normalizeThreads(payload);
  }

  async getPullRequest(pullRequestId: number): Promise<VcsPullRequest> {
    return readAzurePullRequest(this.options, pullRequestId);
  }

  async getPullRequestDiff(pullRequestId: number): Promise<VcsPullRequestDiff> {
    return readAzurePullRequestDiff(this.options, pullRequestId);
  }

  async postPullRequestComment(input: VcsPostCommentInput): Promise<VcsPostCommentResult> {
    if (input.inline && (input.threadId !== undefined || !Number.isSafeInteger(input.inline.line) ||
        input.inline.line <= 0 || !input.inline.path || !input.inline.sourceCommit ||
        !["left", "right"].includes(input.inline.side))) {
      return { status: "failed", message: "Inline comments require a valid new file/line thread, side and source commit (not a reply)." };
    }
    if (input.dryRun) {
      return {
        status: "dry-run",
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        message: input.threadId !== undefined
          ? `dry-run: would reply in thread ${input.threadId} on PR ${input.pullRequestId}`
          : `dry-run: would open a new thread on PR ${input.pullRequestId}`,
      };
    }

    try {
      if (input.threadId !== undefined) {
        // Reply within an existing thread.
        const url = new URL(`${this.threadsPath(input.pullRequestId)}/${input.threadId}/comments`, `${this.options.baseUrl}/`);
        url.searchParams.set("api-version", this.options.apiVersion);
        const response = await this.options.fetchFn(url, {
          method: "POST",
          headers: this.writeHeaders(),
          body: JSON.stringify({ content: input.content, commentType: "text" }),
        });
        if (!response.ok) {
          return { status: "failed", message: `reply ${response.status} ${response.statusText}: ${truncate(await safeText(response), 500)}` };
        }
        const payload = (await response.json()) as Record<string, unknown>;
        return {
          status: "posted",
          threadId: input.threadId,
          ...(typeof payload.id === "number" ? { commentId: payload.id } : {}),
        };
      }

      const inline = input.inline;
      const pullRequestThreadContext = inline
        ? await readAzureInlineThreadContext(this.options, input.pullRequestId, inline)
        : undefined;
      const threadContext = inline ? {
        filePath: `/${inline.path.replace(/^\/+/, "")}`,
        [`${inline.side}FileStart`]: { line: inline.line, offset: 1 },
        [`${inline.side}FileEnd`]: { line: inline.line, offset: 1 },
      } : undefined;
      // Open a new conversation or commit-pinned inline thread.
      const url = this.threadsUrl(input.pullRequestId);
      const response = await this.options.fetchFn(url, {
        method: "POST",
        headers: this.writeHeaders(),
        body: JSON.stringify({
          comments: [{ parentCommentId: 0, content: input.content, commentType: "text" }], status: "active",
          ...(threadContext ? { threadContext, pullRequestThreadContext } : {}),
        }),
      });
      if (!response.ok) {
        return { status: "failed", message: `new thread ${response.status} ${response.statusText}: ${truncate(await safeText(response), 500)}` };
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const threadId = typeof payload.id === "number" ? payload.id : undefined;
      return { status: "posted", ...(threadId !== undefined ? { threadId } : {}) };
    } catch (error) {
      return { status: "failed", message: `Azure DevOps comment failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async getAuthenticatedUserId(): Promise<string | undefined> {
    // Organization-level endpoint; its authenticatedUser.id equals a comment's author.id.
    const url = new URL(`/${encodeURIComponent(this.options.organization)}/_apis/connectionData`, `${this.options.baseUrl}/`);
    url.searchParams.set("api-version", "7.1-preview");
    try {
      const response = await this.options.fetchFn(url, { method: "GET", headers: { Accept: "application/json", Authorization: basicAuth(this.options.pat) } });
      if (!response.ok) return undefined;
      const payload = (await response.json()) as { authenticatedUser?: { id?: unknown } };
      const id = payload.authenticatedUser?.id;
      return typeof id === "string" && id.length > 0 ? id : undefined;
    } catch {
      return undefined;
    }
  }

  async updatePullRequestComment(input: VcsUpdateCommentInput): Promise<VcsPostCommentResult> {
    try {
      const url = new URL(`${this.threadsPath(input.pullRequestId)}/${input.threadId}/comments/${input.commentId}`, `${this.options.baseUrl}/`);
      url.searchParams.set("api-version", this.options.apiVersion);
      const response = await this.options.fetchFn(url, {
        method: "PATCH",
        headers: this.writeHeaders(),
        body: JSON.stringify({ content: input.content }),
      });
      if (!response.ok) {
        return { status: "failed", message: `update comment ${response.status} ${response.statusText}: ${truncate(await safeText(response), 500)}` };
      }
      return { status: "posted", threadId: input.threadId, commentId: input.commentId };
    } catch (error) {
      return { status: "failed", message: `Azure DevOps comment update failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private threadsPath(pullRequestId: number): string {
    return `/${encodeURIComponent(this.options.organization)}/${encodeURIComponent(this.options.project)}/_apis/git/repositories/${encodeURIComponent(this.options.repository)}/pullRequests/${pullRequestId}/threads`;
  }

  private threadsUrl(pullRequestId: number): URL {
    const url = new URL(this.threadsPath(pullRequestId), `${this.options.baseUrl}/`);
    url.searchParams.set("api-version", this.options.apiVersion);
    return url;
  }

  private writeHeaders(): Record<string, string> {
    return {
      Accept: "application/json",
      Authorization: basicAuth(this.options.pat),
      "Content-Type": "application/json",
    };
  }
}

function normalizeThreads(payload: unknown): VcsCommentThread[] {
  if (typeof payload !== "object" || payload === null) return [];
  const value = (payload as Record<string, unknown>).value;
  if (!Array.isArray(value)) return [];

  const threads: VcsCommentThread[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === "number" ? record.id : undefined;
    if (id === undefined) continue;
    const commentsRaw = Array.isArray(record.comments) ? record.comments : [];
    const comments = commentsRaw
      .map((c) => normalizeComment(c))
      .filter((c): c is NonNullable<ReturnType<typeof normalizeComment>> => c !== undefined);
    threads.push({
      id,
      ...(typeof record.status === "string" ? { status: record.status } : {}),
      comments,
    });
  }
  return threads;
}

function normalizeComment(raw: unknown): VcsCommentThread["comments"][number] | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "number" ? record.id : undefined;
  const content = typeof record.content === "string" ? record.content : "";
  if (id === undefined) return undefined;
  const author = record.author;
  const authorName = typeof author === "object" && author !== null ? (author as Record<string, unknown>).displayName : undefined;
  const authorId = typeof author === "object" && author !== null ? (author as Record<string, unknown>).id : undefined;
  return {
    id,
    content,
    ...(typeof authorName === "string" ? { author: authorName } : {}),
    ...(typeof authorId === "string" ? { authorId } : {}),
    ...(typeof record.publishedDate === "string" ? { publishedAt: record.publishedDate } : {}),
  };
}

/**
 * Inspect `git remote get-url origin` inside `repoRoot` and parse the Azure
 * DevOps coordinates from the result. Returns `undefined` when the remote is
 * not an Azure DevOps URL or git is not available.
 */
export async function detectAzureDevOpsRemote(repoRoot: string): Promise<AzureDevOpsRemote | undefined> {
  const remote = await runShellCommand("git remote get-url origin", { cwd: repoRoot });
  if (remote.exitCode !== 0) {
    return undefined;
  }
  return parseAzureDevOpsRemoteUrl(remote.stdout.trim());
}

/** Parse an Azure DevOps remote URL in any of the supported forms. */
export function parseAzureDevOpsRemoteUrl(rawUrl: string): AzureDevOpsRemote | undefined {
  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;

  // https form: https://[user@]dev.azure.com/<org>/<project>/_git/<repo>
  const httpsMatch = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)\/?(?:\?.*)?$/i.exec(trimmed);
  if (httpsMatch) {
    return {
      organization: decodeURIComponent(httpsMatch[1] ?? ""),
      project: decodeURIComponent(httpsMatch[2] ?? ""),
      repository: decodeURIComponent(stripGitSuffix(httpsMatch[3] ?? "")),
      baseUrl: DEFAULT_BASE_URL,
    };
  }

  // Legacy Visual Studio form: https://<org>.visualstudio.com/<project>/_git/<repo>
  const legacyMatch = /^https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/?#]+)\/?(?:\?.*)?$/i.exec(trimmed);
  if (legacyMatch) {
    return {
      organization: decodeURIComponent(legacyMatch[1] ?? ""),
      project: decodeURIComponent(legacyMatch[2] ?? ""),
      repository: decodeURIComponent(stripGitSuffix(legacyMatch[3] ?? "")),
      baseUrl: `https://${legacyMatch[1]}.visualstudio.com`,
    };
  }

  // SSH form: git@ssh.dev.azure.com:v3/<org>/<project>/<repo>
  const sshMatch = /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)\/?$/i.exec(trimmed);
  if (sshMatch) {
    return {
      organization: sshMatch[1] ?? "",
      project: sshMatch[2] ?? "",
      repository: stripGitSuffix(sshMatch[3] ?? ""),
      baseUrl: DEFAULT_BASE_URL,
    };
  }

  return undefined;
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}

function refName(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

function basicAuth(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`, "utf8").toString("base64")}`;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function extractPullRequestId(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>).pullRequestId;
  return typeof value === "number" ? value : undefined;
}

function extractPullRequestUrl(
  payload: unknown,
  options: { baseUrl: string; organization: string; project: string; repository: string },
): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;

  // _links.web.href when present is the human-friendly URL.
  const links = record._links;
  if (typeof links === "object" && links !== null) {
    const web = (links as Record<string, unknown>).web;
    if (typeof web === "object" && web !== null) {
      const href = (web as Record<string, unknown>).href;
      if (typeof href === "string" && href.length > 0) return href;
    }
  }

  // Construct the web URL from the PR id when only the REST `url` is available.
  const id = record.pullRequestId;
  if (typeof id === "number") {
    return `${options.baseUrl}/${encodeURIComponent(options.organization)}/${encodeURIComponent(options.project)}/_git/${encodeURIComponent(options.repository)}/pullrequest/${id}`;
  }
  return undefined;
}
