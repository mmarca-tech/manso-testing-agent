import type { RelatedTicket, TicketLink } from "../contextPack/schema.js";
import type { NormalizedIssue } from "./normalizedIssue.js";

/** Default cap on a related ticket's body before it is visibly truncated. */
export const RELATED_DESCRIPTION_MAX = 2000;

function clampDescription(text: string, max: number): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…[truncated]`;
}

/** Build a {@link RelatedTicket} from a fully-fetched issue. */
export function issueToRelatedTicket(
  issue: NormalizedIssue,
  relationship?: string,
  maxDescription: number = RELATED_DESCRIPTION_MAX,
): RelatedTicket {
  const description = clampDescription(issue.description.text, maxDescription);
  return {
    key: issue.ticket.key,
    title: issue.ticket.title,
    ...(issue.ticket.issueType ? { issueType: issue.ticket.issueType } : {}),
    ...(issue.ticket.status ? { status: issue.ticket.status } : {}),
    ...(relationship ? { relationship } : {}),
    ...(description ? { description } : {}),
    ...(issue.ticket.url ? { url: issue.ticket.url } : {}),
  };
}

/** Fallback when the related issue could not be fetched — use link metadata. */
export function linkToRelatedTicket(link: TicketLink): RelatedTicket | undefined {
  if (!link.issueKey || !link.title) {
    return undefined;
  }
  return {
    key: link.issueKey,
    title: link.title,
    ...(link.issueType ? { issueType: link.issueType } : {}),
    ...(link.status ? { status: link.status } : {}),
    ...(link.relationship ? { relationship: link.relationship } : {}),
    ...(link.url ? { url: link.url } : {}),
  };
}
