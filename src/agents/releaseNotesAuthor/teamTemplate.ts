import type { FixVersion, Ticket, Warning } from "../../domain/contextPack/schema.js";
import type {
  ReleaseMetadata,
  ReleaseNoteEntry,
  ReleaseNoteSection,
  TeamTemplate,
  TeamTemplateRow,
} from "../../domain/releaseNotes/schema.js";

/** Resolutions that mean the work was not delivered, even though the status category is "done". */
const NOT_DELIVERED_RESOLUTION = /won'?t|duplicate|cancel|reject|declin|obsolete|invalid|cannot reproduce/i;

export type Eligibility = { eligible: true } | { eligible: false; reason: string };

/**
 * Decide whether a linked ticket belongs in the release notes. Uses the Jira
 * status *category* (stable across team workflows) rather than status names.
 * Tickets with no status information are kept: we cannot prove they are
 * unreleased, and dropping them silently would be worse.
 */
export function assessEligibility(ticket: Ticket): Eligibility {
  if (ticket.statusCategory && ticket.statusCategory !== "done") {
    return { eligible: false, reason: `Not done (status: ${ticket.status ?? ticket.statusCategory}).` };
  }
  if (ticket.resolution && NOT_DELIVERED_RESOLUTION.test(ticket.resolution)) {
    return { eligible: false, reason: `Resolved without delivery (resolution: ${ticket.resolution}).` };
  }
  return { eligible: true };
}

/**
 * A link a reader can open. Jira REST responses identify issues by their API
 * `self` URL (`…/rest/api/3/issue/<id>`), which serves JSON; release notes need
 * the human page, `<origin>/browse/<KEY>`.
 */
export function browseUrl(ticket: Pick<Ticket, "key" | "url">): string | undefined {
  if (!ticket.url) return undefined;
  if (!/\/rest\/api\//.test(ticket.url)) return ticket.url;
  try {
    const url = new URL(ticket.url);
    // Keep a context path (`https://host/jira/rest/api/…` -> `https://host/jira/browse/KEY`).
    const contextPath = url.pathname.split("/rest/api/")[0];
    return `${url.origin}${contextPath}/browse/${encodeURIComponent(ticket.key)}`;
  } catch {
    return ticket.url;
  }
}

/** Best-effort section from the Jira issue type, used when the LLM did not classify a ticket. */
export function sectionFromIssueType(issueType: string | undefined): ReleaseNoteSection {
  const type = (issueType ?? "").toLowerCase();
  if (/bug|defect|incident/.test(type)) return "bugFix";
  if (/story|feature|epic|initiative/.test(type)) return "newFeature";
  return "maintenance";
}

export interface BuildTeamTemplateInput {
  releaseTicket: Ticket;
  /**
   * Eligible linked tickets, in display order. When empty and the release has no
   * links at all, the release ticket itself is the only row.
   */
  tickets: Ticket[];
  entries: ReleaseNoteEntry[];
  /**
   * The release had linked tickets before exclusion and fetch failures. When they
   * were all dropped the template stays empty: listing the release ticket would
   * present unfinished or cancelled work as shipped.
   */
  hadLinkedTickets?: boolean;
}

export interface BuildTeamTemplateResult {
  releaseMetadata: ReleaseMetadata;
  teamTemplate: TeamTemplate;
  warnings: Warning[];
}

/**
 * Join the LLM's per-ticket prose with deterministic Jira data (link, product
 * affected, release date, contributors) into the team release-note template.
 * Every eligible ticket gets exactly one row: tickets the model skipped fall
 * back to their title and issue type and are flagged for the reviewer; entries
 * for keys outside the release scope are dropped.
 */
export function buildTeamTemplate(input: BuildTeamTemplateInput): BuildTeamTemplateResult {
  const warnings: Warning[] = [];
  // A release with nothing linked (common for JSM changes) is its own single row,
  // so it still appears in the template instead of vanishing.
  const tickets = input.tickets.length > 0 || input.hadLinkedTickets ? input.tickets : [input.releaseTicket];
  const inScope = new Set(tickets.map((t) => t.key));
  const entriesByKey = new Map<string, ReleaseNoteEntry>();
  for (const entry of input.entries) {
    if (!inScope.has(entry.key)) {
      warnings.push(warning(`The LLM wrote a release-note entry for ${entry.key}, which is not in this release's scope; dropped.`));
      continue;
    }
    if (!entriesByKey.has(entry.key)) entriesByKey.set(entry.key, entry);
  }

  const releaseVersions = versionNames(input.releaseTicket.fixVersions);
  const version =
    releaseVersions.length > 0 ? releaseVersions : unique(tickets.flatMap((t) => versionNames(t.fixVersions)));

  // Fallbacks when a ticket has no fix-version date / product of its own.
  const releaseCompletedOn = input.releaseTicket.completedAt?.slice(0, 10);
  const releaseProducts = unique([...(input.releaseTicket.affectedServices ?? []), ...input.releaseTicket.components]);

  const teamTemplate: TeamTemplate = { newFeatures: [], maintenance: [], bugFixes: [] };
  for (const ticket of tickets) {
    const entry = entriesByKey.get(ticket.key);
    if (!entry) {
      warnings.push(warning(`No LLM entry for ${ticket.key}; listed by its title and issue type and flagged for review.`));
    }
    const releaseDate = releaseDateFor(ticket.fixVersions, version) ?? releaseCompletedOn;
    const ownProducts = unique([...(ticket.affectedServices ?? []), ...ticket.components]);
    const why = entry?.why?.trim();
    const row: TeamTemplateRow = {
      ticketKey: ticket.key,
      ...(browseUrl(ticket) ? { ticketUrl: browseUrl(ticket) } : {}),
      description: entry?.description ?? ticket.title,
      ...(why ? { why } : {}),
      // A ticket with no product of its own inherits the release's (e.g. a JSM change's Affected services).
      productAffected: ownProducts.length > 0 ? ownProducts : releaseProducts,
      ...(releaseDate ? { releaseDate } : {}),
      insufficientContext: entry ? entry.insufficientContext || !why : true,
    };
    const section = entry?.section ?? sectionFromIssueType(ticket.issueType);
    sectionRows(teamTemplate, section).push(row);
  }

  const dates = [
    ...tickets.map((t) => releaseDateFor(t.fixVersions, version)),
    releaseDateFor(input.releaseTicket.fixVersions, version) ?? releaseCompletedOn,
  ]
    .filter((d): d is string => Boolean(d))
    .sort();

  const releaseMetadata: ReleaseMetadata = {
    ...(version.length > 0 ? { version: version.join(", ") } : {}),
    ...(dates.length > 0 ? { dateFrom: dates[0], dateTo: dates[dates.length - 1] } : {}),
    contributors: unique(tickets.map((t) => t.assignee?.name).filter((n): n is string => Boolean(n))),
  };

  return { releaseMetadata, teamTemplate, warnings };
}

function sectionRows(template: TeamTemplate, section: ReleaseNoteSection): TeamTemplateRow[] {
  switch (section) {
    case "newFeature":
      return template.newFeatures;
    case "bugFix":
      return template.bugFixes;
    case "maintenance":
      return template.maintenance;
  }
}

function versionNames(versions: FixVersion[] | undefined): string[] {
  return unique((versions ?? []).map((v) => v.name));
}

/** Prefer the date of a fix version that belongs to this release; else the first dated one. */
function releaseDateFor(versions: FixVersion[] | undefined, releaseVersions: string[]): string | undefined {
  const dated = (versions ?? []).filter((v) => v.releaseDate);
  return (dated.find((v) => releaseVersions.includes(v.name)) ?? dated[0])?.releaseDate;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))];
}

function warning(message: string): Warning {
  return { section: "releaseNotes", toolName: "release-notes:template", message };
}
