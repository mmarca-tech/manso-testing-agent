import type {
  Attachment,
  Comment,
  ConfluencePage,
  Development,
  TicketLink,
  ToolProvenance,
  Warning,
} from "../../domain/contextPack/schema.js";
import type { NormalizedIssue } from "../../domain/tickets/normalizedIssue.js";

export type TicketSourceName = "jira-rest";

/** Raw bytes of an attachment, downloaded on demand for content analysis. */
export interface AttachmentContent {
  data: Uint8Array;
  /** The server-reported content type, if available. */
  mimeType?: string;
}

export interface TicketSource {
  getSourceName(): TicketSourceName;
  getIssue(issueKey: string): Promise<NormalizedIssue>;
  getComments(issueKey: string): Promise<Comment[]>;
  getAttachments(issueKey: string): Promise<Attachment[]>;
  getLinkedIssues(issueKey: string): Promise<TicketLink[]>;
  getDevelopmentLinks(issueKey: string): Promise<Development>;
  getConfluencePages(issueKey: string): Promise<ConfluencePage[]>;
  getProvenance(): ToolProvenance[];
  getWarnings(): Warning[];
  close(): Promise<void>;
  /**
   * Download an attachment's bytes for content analysis (M10e). Optional —
   * providers that cannot serve attachment content simply omit it, and the
   * Researcher skips analysis with a warning.
   */
  fetchAttachmentContent?(attachment: Attachment): Promise<AttachmentContent | undefined>;
}
