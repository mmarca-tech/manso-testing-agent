import { runShellCommand } from "../shell/runShellCommand.js";
import { readGitHubPullRequest, readGitHubPullRequestDiff } from "./pullRequestReader.js";
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

export interface GitHubRemote {
  owner: string;
  repo: string;
  /** Host, e.g. "github.com" or "github.example.com". */
  host: string;
  /** REST API base, e.g. "https://api.github.com" or "https://host/api/v3". */
  apiBaseUrl: string;
}

export interface GitHubAdapterOptions {
  owner: string;
  repo: string;
  /** Personal access / fine-grained token with `pull_requests:write`. */
  token: string;
  /** REST API base. Defaults to https://api.github.com. */
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
  apiVersion?: string;
}

const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_API_VERSION = "2022-11-28";
/** Sentinel thread id for the PR's issue-comment conversation (flat timeline). */
const CONVERSATION_THREAD_ID = 0;
const COMMENTS_PER_PAGE = 100;
const MAX_COMMENT_PAGES = 50;

/**
 * VcsAdapter for GitHub (github.com and GitHub Enterprise). Mirrors
 * {@link AzureDevOpsAdapter}: raises PRs and reads/writes PR comments.
 *
 * GitHub has two comment systems, both surfaced here:
 *   - issue comments (the PR conversation timeline) → one flat thread,
 *     `id: 0`; replying posts another issue comment.
 *   - review comments (threaded on diff lines) → one thread per root comment,
 *     `id` = the root comment id; replying uses the review-comment replies API.
 *
 * Auth: token via the `Authorization: Bearer` header. A `User-Agent` is sent
 * because GitHub rejects requests without one.
 */
export class GitHubAdapter implements VcsAdapter {
  readonly kind = "github" as const;
  private readonly options: Required<Omit<GitHubAdapterOptions, "fetchFn">> & { fetchFn: typeof fetch };

  constructor(options: GitHubAdapterOptions) {
    this.options = {
      owner: options.owner,
      repo: options.repo,
      token: options.token,
      apiBaseUrl: (options.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, ""),
      apiVersion: options.apiVersion ?? DEFAULT_API_VERSION,
      fetchFn: options.fetchFn ?? fetch,
    };
  }

  async raisePullRequest(input: VcsRaisePullRequestInput): Promise<VcsRaisePullRequestResult> {
    if (input.dryRun) {
      return {
        status: "dry-run",
        message: `dry-run: would POST PR from ${input.branch} into ${input.targetBranch} in ${this.options.owner}/${this.options.repo}`,
      };
    }

    let response: Response;
    try {
      response = await this.request("POST", `/repos/${this.seg(this.options.owner)}/${this.seg(this.options.repo)}/pulls`, {
        title: input.title,
        head: stripRef(input.branch),
        base: stripRef(input.targetBranch),
        ...(input.description ? { body: input.description } : {}),
      });
    } catch (error) {
      return { status: "failed", message: `GitHub PR create failed: ${errorMessage(error)}` };
    }

    if (response.status === 422) {
      const text = await safeText(response);
      // 422 covers "a PR already exists for this head/base" and other validation
      // errors — distinguish on the message.
      const exists = /already exists|pull request already/i.test(text);
      return {
        status: exists ? "exists" : "failed",
        message: `${exists ? "A pull request already exists" : "GitHub PR create rejected"} for ${input.branch} → ${input.targetBranch}: ${truncate(text, 500)}`,
      };
    }
    if (!response.ok) {
      return { status: "failed", message: `GitHub PR create ${response.status} ${response.statusText}: ${truncate(await safeText(response), 500)}` };
    }

    const payload = (await safeJson(response)) as Record<string, unknown>;
    const number = typeof payload.number === "number" ? payload.number : undefined;
    const url = typeof payload.html_url === "string" ? payload.html_url : undefined;
    return {
      status: "raised",
      ...(number !== undefined ? { pullRequestId: number } : {}),
      ...(url ? { url } : {}),
    };
  }

  async listPullRequestThreads(pullRequestId: number): Promise<VcsCommentThread[]> {
    const threads: VcsCommentThread[] = [];

    // Issue comments → a single flat conversation thread.
    const issueComments = await this.getAll(
      `/repos/${this.seg(this.options.owner)}/${this.seg(this.options.repo)}/issues/${pullRequestId}/comments`,
    );
    if (issueComments.length > 0) {
      threads.push({
        id: CONVERSATION_THREAD_ID,
        status: "active",
        comments: issueComments.map((c) => normalizeComment(c)),
      });
    }

    // Review comments → grouped into threads by their root comment.
    const reviewComments = await this.getAll(
      `/repos/${this.seg(this.options.owner)}/${this.seg(this.options.repo)}/pulls/${pullRequestId}/comments`,
    );
    const byRoot = new Map<number, VcsCommentThread["comments"]>();
    for (const raw of reviewComments) {
      const id = typeof raw.id === "number" ? raw.id : undefined;
      if (id === undefined) continue;
      const rootId = typeof raw.in_reply_to_id === "number" ? raw.in_reply_to_id : id;
      const list = byRoot.get(rootId) ?? [];
      list.push(normalizeComment(raw));
      byRoot.set(rootId, list);
    }
    for (const [rootId, comments] of byRoot) {
      threads.push({ id: rootId, status: "active", comments });
    }

    return threads;
  }

  async getPullRequest(pullRequestId: number): Promise<VcsPullRequest> {
    return readGitHubPullRequest(this.options, pullRequestId);
  }

  async getPullRequestDiff(pullRequestId: number): Promise<VcsPullRequestDiff> {
    return readGitHubPullRequestDiff(this.options, pullRequestId);
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
        message: `dry-run: would comment on PR ${input.pullRequestId}`,
      };
    }

    const owner = this.seg(this.options.owner);
    const repo = this.seg(this.options.repo);
    const isReviewReply = input.threadId !== undefined && input.threadId !== CONVERSATION_THREAD_ID;
    const path = input.inline
      ? `/repos/${owner}/${repo}/pulls/${input.pullRequestId}/comments`
      : isReviewReply
      ? `/repos/${owner}/${repo}/pulls/${input.pullRequestId}/comments/${input.threadId}/replies`
      : `/repos/${owner}/${repo}/issues/${input.pullRequestId}/comments`;

    try {
      const inline = input.inline;
      const response = await this.request("POST", path, {
        body: input.content,
        ...(inline ? {
          commit_id: inline.sourceCommit, path: inline.path.replace(/^\/+/, ""),
          line: inline.line, side: inline.side === "left" ? "LEFT" : "RIGHT",
        } : {}),
      });
      if (!response.ok) {
        return { status: "failed", message: `GitHub comment ${response.status} ${response.statusText}: ${truncate(await safeText(response), 500)}` };
      }
      const payload = (await safeJson(response)) as Record<string, unknown>;
      const commentId = typeof payload.id === "number" ? payload.id : undefined;
      return {
        status: "posted",
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        ...(commentId !== undefined ? { commentId } : {}),
      };
    } catch (error) {
      return { status: "failed", message: `GitHub comment failed: ${errorMessage(error)}` };
    }
  }

  async getAuthenticatedUserId(): Promise<string | undefined> {
    try {
      // Not available to GitHub App installation tokens (403/404): then the identity is unknown.
      const response = await this.request("GET", "/user");
      if (!response.ok) return undefined;
      const payload = (await safeJson(response)) as Record<string, unknown>;
      return typeof payload.id === "number" ? String(payload.id) : undefined;
    } catch {
      return undefined;
    }
  }

  async updatePullRequestComment(input: VcsUpdateCommentInput): Promise<VcsPostCommentResult> {
    const owner = this.seg(this.options.owner);
    const repo = this.seg(this.options.repo);
    // Conversation comments live under /issues; inline review comments under /pulls.
    const path = input.threadId === CONVERSATION_THREAD_ID
      ? `/repos/${owner}/${repo}/issues/comments/${input.commentId}`
      : `/repos/${owner}/${repo}/pulls/comments/${input.commentId}`;
    try {
      const response = await this.request("PATCH", path, { body: input.content });
      if (!response.ok) {
        return { status: "failed", message: `GitHub comment update ${response.status} ${response.statusText}: ${truncate(await safeText(response), 500)}` };
      }
      return { status: "posted", threadId: input.threadId, commentId: input.commentId };
    } catch (error) {
      return { status: "failed", message: `GitHub comment update failed: ${errorMessage(error)}` };
    }
  }

  private async getAll(path: string): Promise<Array<Record<string, unknown>>> {
    const all: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
      const response = await this.request("GET", `${path}?per_page=${COMMENTS_PER_PAGE}&page=${page}`);
      if (!response.ok) {
        throw new Error(`GitHub GET ${path} ${response.status} ${response.statusText}: ${truncate(await safeText(response), 300)}`);
      }
      const payload = await safeJson(response);
      const items = Array.isArray(payload) ? (payload.filter((x) => typeof x === "object" && x !== null) as Array<Record<string, unknown>>) : [];
      all.push(...items);
      if (items.length < COMMENTS_PER_PAGE) return all;
    }
    // Returning a truncated list would make callers (e.g. review de-duplication) act on partial data.
    throw new Error(`GitHub GET ${path} has more than ${MAX_COMMENT_PAGES * COMMENTS_PER_PAGE} entries; refusing to use a partial list.`);
  }

  private request(method: string, path: string, body?: unknown): Promise<Response> {
    const url = new URL(path.replace(/^\//, ""), `${this.options.apiBaseUrl}/`);
    return this.options.fetchFn(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.options.token}`,
        "X-GitHub-Api-Version": this.options.apiVersion,
        "User-Agent": "manso",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  private seg(value: string): string {
    return encodeURIComponent(value);
  }
}

function normalizeComment(raw: Record<string, unknown>): VcsCommentThread["comments"][number] {
  const id = typeof raw.id === "number" ? raw.id : 0;
  const content = typeof raw.body === "string" ? raw.body : "";
  const user = typeof raw.user === "object" && raw.user !== null ? (raw.user as Record<string, unknown>) : undefined;
  const author = user && typeof user.login === "string" ? user.login : undefined;
  const authorId = user && typeof user.id === "number" ? String(user.id) : undefined;
  return {
    id,
    content,
    ...(author ? { author } : {}),
    ...(authorId ? { authorId } : {}),
    ...(typeof raw.created_at === "string" ? { publishedAt: raw.created_at } : {}),
  };
}

/**
 * Inspect `git remote get-url origin` in `repoRoot` and parse GitHub
 * coordinates. Returns `undefined` for non-GitHub remotes or when git fails.
 */
export async function detectGitHubRemote(repoRoot: string): Promise<GitHubRemote | undefined> {
  const remote = await runShellCommand("git remote get-url origin", { cwd: repoRoot });
  if (remote.exitCode !== 0) {
    return undefined;
  }
  return parseGitHubRemoteUrl(remote.stdout.trim());
}

/** Parse a GitHub remote URL (https or ssh; github.com or Enterprise). */
export function parseGitHubRemoteUrl(rawUrl: string): GitHubRemote | undefined {
  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;

  // https form: https://[user@]<host>/<owner>/<repo>[.git]
  const https = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i.exec(trimmed);
  if (https && isGitHubHost(https[1] ?? "")) {
    return buildRemote(https[1] ?? "", https[2] ?? "", https[3] ?? "");
  }

  // ssh form: git@<host>:<owner>/<repo>[.git]
  const ssh = /^git@([^:]+):([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (ssh && isGitHubHost(ssh[1] ?? "")) {
    return buildRemote(ssh[1] ?? "", ssh[2] ?? "", ssh[3] ?? "");
  }

  // ssh:// form: ssh://git@<host>/<owner>/<repo>[.git]
  const sshUrl = /^ssh:\/\/git@([^/]+)\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (sshUrl && isGitHubHost(sshUrl[1] ?? "")) {
    return buildRemote(sshUrl[1] ?? "", sshUrl[2] ?? "", sshUrl[3] ?? "");
  }

  return undefined;
}

function isGitHubHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "github.com" || h === "www.github.com" || h.includes("github");
}

function buildRemote(host: string, owner: string, repo: string): GitHubRemote {
  const normalizedHost = host.toLowerCase() === "www.github.com" ? "github.com" : host;
  const apiBaseUrl = normalizedHost === "github.com" ? DEFAULT_API_BASE : `https://${normalizedHost}/api/v3`;
  return { owner, repo, host: normalizedHost, apiBaseUrl };
}

function stripRef(branch: string): string {
  return branch.replace(/^refs\/heads\//, "");
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
