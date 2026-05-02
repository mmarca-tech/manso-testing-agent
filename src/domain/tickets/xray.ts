import type { TicketLink, XrayTestCase } from "../contextPack/schema.js";
import type { NormalizedIssue } from "./normalizedIssue.js";

export function issueToXrayTestCase(issue: NormalizedIssue, relationship?: string): XrayTestCase {
  return {
    key: issue.ticket.key,
    title: issue.ticket.title,
    labels: issue.ticket.labels,
    ...(issue.ticket.status ? { status: issue.ticket.status } : {}),
    ...(issue.description.text ? { description: issue.description.text } : {}),
    ...(relationship ? { relationship } : {}),
    ...(issue.ticket.url ? { url: issue.ticket.url } : {}),
  };
}

export function linkToXrayTestCase(link: TicketLink): XrayTestCase | undefined {
  if (!link.issueKey || !link.title) {
    return undefined;
  }

  return {
    key: link.issueKey,
    title: link.title,
    labels: [],
    ...(link.status ? { status: link.status } : {}),
    ...(link.relationship ? { relationship: link.relationship } : {}),
    ...(link.url ? { url: link.url } : {}),
  };
}

export function isXrayTestLink(link: TicketLink): boolean {
  const issueType = (link.issueType ?? "").trim().toLowerCase();
  return issueType === "test" || issueType === "test case";
}
