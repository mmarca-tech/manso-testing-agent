/**
 * Pluggable interface every VCS provider implements. The first concrete
 * implementation is {@link AzureDevOpsAdapter}; GitHub and GitLab can drop in
 * later without touching the Implementer or Verifier.
 */
export interface VcsAdapter {
  readonly kind: VcsAdapterKind;
  raisePullRequest(input: VcsRaisePullRequestInput): Promise<VcsRaisePullRequestResult>;
  /**
   * List the comment threads on a pull request (M12). Optional — adapters that
   * cannot read threads omit it and the responder reports that it cannot run.
   */
  listPullRequestThreads?(pullRequestId: number): Promise<VcsCommentThread[]>;
  /** Post a conversation comment, an inline finding, or a reply in an existing thread. */
  postPullRequestComment?(input: VcsPostCommentInput): Promise<VcsPostCommentResult>;
  /**
   * Identity of the account the adapter's token acts as, in the same form as
   * {@link VcsComment.authorId}; undefined when the platform will not say. Used to
   * trust only comments this tool itself wrote.
   */
  getAuthenticatedUserId?(): Promise<string | undefined>;
  /** Replace the body of a comment this tool previously posted (idempotent review summaries). */
  updatePullRequestComment?(input: VcsUpdateCommentInput): Promise<VcsPostCommentResult>;
  /** Read metadata for proactive review (no checkout or repository edits). */
  getPullRequest?(pullRequestId: number): Promise<VcsPullRequest>;
  /** Read a base-to-head diff, reporting any incomplete evidence explicitly. */
  getPullRequestDiff?(pullRequestId: number): Promise<VcsPullRequestDiff>;
}

export interface VcsPullRequest {
  id: number;
  title: string;
  description?: string;
  sourceBranch?: string;
  targetBranch?: string;
  sourceCommit?: string;
  targetCommit?: string;
  url: string;
}

export interface VcsChangedFile {
  path: string;
  changeType: "add" | "edit" | "delete" | "rename" | "unknown";
  patch?: string;
}

export interface VcsPullRequestDiff {
  files: VcsChangedFile[];
  hasPatches: boolean;
  allChangesIncluded?: boolean;
  warnings?: string[];
}

/** A single comment within a PR thread. */
export interface VcsComment {
  id: number;
  /** Comment body (markdown). */
  content: string;
  /** Author display name, when available. */
  author?: string;
  /** Author unique id (e.g. Azure DevOps descriptor), when available. */
  authorId?: string;
  /** ISO timestamp the comment was published, when available. */
  publishedAt?: string;
}

/** A PR comment thread (a root comment plus replies). */
export interface VcsCommentThread {
  id: number;
  /** Thread status, e.g. "active" | "fixed" | "closed" (platform-specific). */
  status?: string;
  comments: VcsComment[];
}

export interface VcsPostCommentInput {
  pullRequestId: number;
  content: string;
  /** When set, reply inside this existing thread; otherwise open a new thread. */
  threadId?: number;
  /** New inline thread anchored to a reviewed source commit; never a reply. */
  inline?: VcsInlineCommentLocation;
  /** When true, do not call the platform API; report what would happen. */
  dryRun?: boolean;
}

export interface VcsUpdateCommentInput {
  pullRequestId: number;
  threadId: number;
  commentId: number;
  content: string;
}

export interface VcsInlineCommentLocation {
  path: string;
  line: number;
  /** Left = original/deleted line; right = new line. */
  side: "left" | "right";
  sourceCommit: string;
}

export interface VcsPostCommentResult {
  status: "posted" | "dry-run" | "failed";
  threadId?: number;
  commentId?: number;
  message?: string;
}

export type VcsAdapterKind = "azure-devops" | "github" | "gitlab";

export interface VcsRaisePullRequestInput {
  /** Source branch (already pushed by the caller). */
  branch: string;
  /** Target branch (e.g. "main"). */
  targetBranch: string;
  /** PR title shown in the platform UI. */
  title: string;
  /** Optional PR description / body. */
  description?: string;
  /** When true, do not call the platform API; report what would happen. */
  dryRun?: boolean;
}

export type VcsRaisePullRequestStatus = "raised" | "updated" | "exists" | "skipped" | "failed" | "dry-run";

export interface VcsRaisePullRequestResult {
  status: VcsRaisePullRequestStatus;
  /** Web URL of the PR, when available. */
  url?: string;
  /** Platform-specific PR identifier. */
  pullRequestId?: number;
  /** Free-form detail for the report (especially on "failed" / "skipped"). */
  message?: string;
}
