import type { Comment, Description, Ticket, TicketLink } from "../contextPack/schema.js";

export interface NormalizedIssue {
  ticket: Ticket;
  description: Description;
  comments: Comment[];
  linkedIssues: TicketLink[];
}
