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
}
