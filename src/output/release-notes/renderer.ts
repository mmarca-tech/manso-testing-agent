import { formatDateRange } from "../../agents/releaseNotesAuthor/index.js";
import type { MonthlyReleaseNotesPack, ReleaseNotesPack, TeamReleaseNotes } from "../../domain/releaseNotes/schema.js";

/**
 * Render the release notes as a plain, external-facing markdown document.
 * Deliberately excludes `ticketSummaries` and any ticket keys/branch/PR
 * info — those live only in the JSON pack for traceability (see the
 * no-internal-leakage constraint in the authoring agent).
 */
export function renderReleaseNotesMarkdown(pack: ReleaseNotesPack): string {
  const { notes } = pack;
  const lines: string[] = [];

  lines.push(`# ${notes.title}`, "");
  lines.push(notes.summary, "");

  if (notes.highlights.length > 0) {
    lines.push("## Highlights", "");
    for (const highlight of notes.highlights) {
      lines.push(`- ${highlight}`);
    }
    lines.push("");
  }

  if (notes.changeItems.length > 0) {
    lines.push("## What's Changed", "");
    for (const item of notes.changeItems) {
      lines.push(`- **${item.area}**: ${item.description}`);
    }
    lines.push("");
  }

  pushList(lines, "Action Needed", notes.actionNeeded);

  if (notes.deploymentNotes.length > 0) {
    lines.push("## Deployment Notes", "");
    for (const note of notes.deploymentNotes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }

  if (notes.testingNotes.length > 0) {
    lines.push("## Testing Notes", "");
    for (const note of notes.testingNotes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }

  if (notes.knownRisks.length > 0) {
    lines.push("## Known Risks", "");
    for (const risk of notes.knownRisks) {
      lines.push(`- ${risk}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

const TEAM_SECTIONS: Array<[keyof TeamReleaseNotes["teamTemplate"], string, string]> = [
  ["newFeatures", "New Features", "New Feature Description *(Why)*"],
  ["maintenance", "Maintenance", "Maintenance Description"],
  ["bugFixes", "Bug fixes", "Bug Fix Description"],
];

/**
 * Render the internal, team-facing release notes following the Product Team X
 * release-note template: a metadata table, then New Features / Maintenance /
 * Bug fixes tables with ticket links. Ends with a reviewer-only list of
 * excluded tickets. Unlike {@link renderReleaseNotesMarkdown}, ticket keys and
 * links are intended here — every row must be traceable to Jira.
 */
export function renderTeamReleaseNotesMarkdown(release: TeamReleaseNotes): string {
  const { notes, releaseMetadata, teamTemplate, excludedTickets } = release;
  const lines: string[] = [];

  lines.push(`# ${notes.title}`, "");
  lines.push("| | |", "| --- | --- |");
  lines.push(`| **Release Version** | ${cell(releaseMetadata.version ?? "")} |`);
  lines.push(`| **Release Date** | ${cell(formatDateRange(releaseMetadata))} |`);
  lines.push(`| **Description** | ${cell(notes.summary)} |`);
  lines.push(`| **Contributors** | ${cell(releaseMetadata.contributors.join(", "))} |`, "");

  for (const [key, heading, descriptionHeader] of TEAM_SECTIONS) {
    lines.push(`## ${heading}`, "");
    const rows = teamTemplate[key];
    if (rows.length === 0) {
      lines.push("_None in this release._", "");
      continue;
    }
    lines.push(`| ${descriptionHeader} | Ticket Link | Product affected | Release Date |`, "| --- | --- | --- | --- |");
    for (const row of rows) {
      const description = [
        row.description,
        row.why ? `*Why:* ${row.why}` : "",
        row.insufficientContext ? "**⚠ Needs context from the team.**" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const ticket = row.ticketUrl ? `[${row.ticketKey}](${row.ticketUrl})` : row.ticketKey;
      lines.push(
        `| ${cell(description)} | ${cell(ticket)} | ${cell(row.productAffected.join(", "))} | ${cell(row.releaseDate ?? "")} |`,
      );
    }
    lines.push("");
  }

  pushList(lines, "Action Needed", notes.actionNeeded);
  pushList(lines, "Deployment Notes", notes.deploymentNotes);
  pushList(lines, "Testing Notes", notes.testingNotes);
  pushList(lines, "Known Risks", notes.knownRisks);

  if (excludedTickets.length > 0) {
    lines.push("## Excluded from these notes (reviewer only)", "");
    for (const ticket of excludedTickets) {
      lines.push(`- **${ticket.key}** ${ticket.title}: ${ticket.reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function pushList(lines: string[], heading: string, items: string[]): void {
  if (items.length === 0) return;
  lines.push(`## ${heading}`, "");
  for (const item of items) {
    lines.push(`- ${item}`);
  }
  lines.push("");
}

/** Keep a value inside one markdown table cell. */
function cell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

// ---------------------------------------------------------------------------
// Monthly summary (many releases)
// ---------------------------------------------------------------------------

/** "2026-10" → "October 2026". */
export function formatMonthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber) return month;
  const name = new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
  return `${name} ${year}`;
}

function completedOn(release: ReleaseNotesPack): string | undefined {
  return release.releaseTicket?.completedAt?.slice(0, 10) ?? release.releaseMetadata.dateTo;
}

function ticketLink(key: string, url: string | undefined): string {
  return url ? `[${key}](${url})` : key;
}

function monthlyDateRange(pack: MonthlyReleaseNotesPack): string {
  const dates = pack.releases
    .map(completedOn)
    .filter((d): d is string => Boolean(d))
    .sort();
  return formatDateRange({ ...(dates.length > 0 ? { dateFrom: dates[0], dateTo: dates[dates.length - 1] } : {}), contributors: [] });
}

/**
 * Render the internal monthly notes: the team release-note template with the
 * three section tables aggregated across every release of the month. Each row
 * links its ticket and the release (change) it shipped with, so the month
 * stays traceable to Jira. Ends with the list of releases and the excluded
 * tickets, both reviewer-facing.
 */
export function renderMonthlyTeamReleaseNotesMarkdown(pack: MonthlyReleaseNotesPack): string {
  const lines: string[] = [];
  const contributors = [...new Set(pack.releases.flatMap((r) => r.releaseMetadata.contributors))];

  lines.push(`# ${pack.summary.title}`, "");
  lines.push("| | |", "| --- | --- |");
  lines.push(`| **Release Version** | ${cell(`${pack.project} ${formatMonthLabel(pack.month)}`)} |`);
  lines.push(`| **Release Date** | ${cell(monthlyDateRange(pack))} |`);
  lines.push(`| **Description** | ${cell(pack.summary.summary)} |`);
  lines.push(`| **Contributors** | ${cell(contributors.join(", "))} |`, "");

  pushList(lines, "Highlights", pack.summary.highlights);

  for (const [key, heading, descriptionHeader] of TEAM_SECTIONS) {
    lines.push(`## ${heading}`, "");
    const rows = pack.releases.flatMap((release) => release.teamTemplate[key].map((row) => ({ release, row })));
    if (rows.length === 0) {
      lines.push("_None this month._", "");
      continue;
    }
    lines.push(`| ${descriptionHeader} | Ticket Link | Product affected | Release Date |`, "| --- | --- | --- | --- |");
    for (const { release, row } of rows) {
      const description = [
        row.description,
        row.why ? `*Why:* ${row.why}` : "",
        row.insufficientContext ? "**⚠ Needs context from the team.**" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const ticket =
        row.ticketKey === release.releaseIssueKey
          ? ticketLink(row.ticketKey, row.ticketUrl)
          : `${ticketLink(row.ticketKey, row.ticketUrl)} via ${ticketLink(release.releaseIssueKey, release.releaseTicket?.url)}`;
      lines.push(
        `| ${cell(description)} | ${cell(ticket)} | ${cell(row.productAffected.join(", "))} | ${cell(row.releaseDate ?? "")} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Releases this month", "");
  if (pack.releases.length === 0) {
    lines.push("_None._", "");
  } else {
    lines.push("| Change | Title | Completed | Rows |", "| --- | --- | --- | --- |");
    for (const release of pack.releases) {
      const rows = release.teamTemplate.newFeatures.length + release.teamTemplate.maintenance.length + release.teamTemplate.bugFixes.length;
      lines.push(
        `| ${cell(ticketLink(release.releaseIssueKey, release.releaseTicket?.url))} | ${cell(release.releaseTicket?.title ?? release.notes.title)} | ${cell(completedOn(release) ?? "")} | ${rows} |`,
      );
    }
    lines.push("");
  }

  const excluded = pack.releases.flatMap((release) => release.excludedTickets.map((ticket) => ({ release, ticket })));
  if (excluded.length > 0 || pack.failedKeys.length > 0) {
    lines.push("## Excluded from these notes (reviewer only)", "");
    for (const { release, ticket } of excluded) {
      lines.push(`- **${ticket.key}** (via ${release.releaseIssueKey}) ${ticket.title}: ${ticket.reason}`);
    }
    for (const key of pack.failedKeys) {
      lines.push(`- **${key}**: release notes could not be generated; see warnings in the JSON pack.`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Render the external monthly notes: the month summary, then one section per
 * release with its own summary and changes. Same no-leakage rule as
 * {@link renderReleaseNotesMarkdown}: no ticket keys, links, branches or PRs.
 */
export function renderMonthlyExternalMarkdown(pack: MonthlyReleaseNotesPack): string {
  const lines: string[] = [];

  lines.push(`# ${pack.summary.title}`, "");
  lines.push(pack.summary.summary, "");
  pushList(lines, "Highlights", pack.summary.highlights);

  if (pack.releases.length > 0) {
    lines.push("## Releases", "");
  }
  for (const release of pack.releases) {
    const { notes } = release;
    lines.push(`### ${notes.title}`, "");
    const date = completedOn(release);
    if (date) lines.push(`_Released ${date}_`, "");
    lines.push(notes.summary, "");
    if (notes.changeItems.length > 0) {
      for (const item of notes.changeItems) {
        lines.push(`- **${item.area}**: ${item.description}`);
      }
      lines.push("");
    }
    if (notes.actionNeeded.length > 0) {
      lines.push("**Action needed:**", "");
      for (const action of notes.actionNeeded) {
        lines.push(`- ${action}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
