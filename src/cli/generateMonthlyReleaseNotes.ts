import { authorMonthlySummary } from "../agents/releaseNotesAuthor/index.js";
import type { ContextProvider } from "../context/providerRegistry.js";
import type { Warning } from "../domain/contextPack/schema.js";
import {
  MONTHLY_RELEASE_NOTES_SCHEMA_VERSION,
  MonthlyReleaseNotesPackSchema,
  type MonthlyReleaseNotesPack,
  type ReleaseNotesPack,
} from "../domain/releaseNotes/schema.js";
import type { AtlassianRestClient } from "../integrations/atlassianRest/client.js";
import { jiraIssueSessionId, withTelemetrySession } from "../integrations/llm/telemetry/observability.js";
import type { LlmTextClient } from "../integrations/llm/types.js";
import type { VcsTokens } from "../integrations/vcs/resolve.js";
import { formatMonthLabel } from "../output/release-notes/renderer.js";
import { writeMonthlyReleaseNotesPack } from "../output/release-notes/writer.js";
import { mapWithConcurrency } from "../shared/concurrency.js";
import { formatDuration, ProgressReporter, type ProgressStream } from "../shared/progress.js";
import { CliError } from "../shared/cli.js";
import { firstPresent, firstString } from "../shared/utils.js";
import { buildReleaseNotesPack } from "./generateReleaseNotes.js";

export const DEFAULT_MONTHLY_STATUS = "Completed";
export const DEFAULT_MONTHLY_CONCURRENCY = 4;
export const MAX_MONTHLY_CONCURRENCY = 8;
const SEARCH_PAGE_SIZE = 100;
/** JSM field holding when a change's deployment actually finished; referenced by name so no site-specific id is needed. */
const COMPLETION_DATE_FIELD = "Change completion date";

export interface GenerateMonthlyReleaseNotesInput {
  /** Jira project key, e.g. "ITSM". */
  project: string;
  /** Issue type id (e.g. "10903") or name. */
  issueType: string;
  /** `YYYY-MM`; see {@link parseMonth}. */
  month: string;
  /** Status that means "successfully completed". Defaults to "Completed". */
  status?: string;
  /** Extra JQL ANDed onto the generated query, e.g. a team or service filter. */
  extraJql?: string;
  /** Releases processed in parallel. Defaults to 4, clamped to 1–8. */
  concurrency?: number;
  outDir: string;
  /** A fresh provider per release: providers accumulate warnings/provenance per instance. */
  providerFactory: () => ContextProvider;
  llm: LlmTextClient;
  jira: AtlassianRestClient;
  repoRoot?: string;
  vcsTokens: VcsTokens;
  maxLinkedTickets?: number;
  onProgress?: (event: MonthlyProgressEvent) => void;
}

/** Structured progress, so the CLI can render a bar (TTY) or plain lines (CI) as it sees fit. */
export type MonthlyProgressEvent =
  | { type: "matched"; scope: string; total: number; concurrency: number }
  | { type: "release-started"; key: string }
  | {
      type: "release-finished";
      key: string;
      ok: true;
      durationMs: number;
      /** Template rows the release contributed. */
      rows: number;
      excluded: number;
      /** True when the LLM failed and the release has fallback notes. */
      fallback: boolean;
    }
  | { type: "release-finished"; key: string; ok: false; durationMs: number; error: string }
  | { type: "summarising"; releases: number };

export interface GenerateMonthlyReleaseNotesOutput {
  matchedCount: number;
  processedCount: number;
  failedKeys: string[];
  jsonPath: string;
  markdownPath: string;
  externalMarkdownPath: string;
}

/**
 * Parse `--date`: `MM/YY` (e.g. `10/26`), `MM/YYYY` or `YYYY-MM`, into `YYYY-MM`.
 * Two-digit years are 20YY.
 */
export function parseMonth(value: string): string {
  const trimmed = value.trim();
  const slash = /^(\d{1,2})\/(\d{2}|\d{4})$/.exec(trimmed);
  const iso = /^(\d{4})-(\d{1,2})$/.exec(trimmed);
  const [year, month] = slash
    ? [slash[2]!.length === 2 ? 2000 + Number(slash[2]) : Number(slash[2]), Number(slash[1])]
    : iso
      ? [Number(iso[1]), Number(iso[2])]
      : [NaN, NaN];
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new CliError(`--date must be MM/YY (e.g. 10/26), MM/YYYY or YYYY-MM; got "${value}".`);
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

export interface MonthlyJqlInput {
  project: string;
  issueType: string;
  month: string;
  status?: string;
  extraJql?: string;
}

/**
 * Build the JQL selecting a month's completed releases. A release belongs to
 * the month of its "Change completion date", or of its resolution date when
 * that field is empty.
 */
export function buildMonthlyJql(input: MonthlyJqlInput): string {
  if (!/^[A-Z][A-Z0-9_]+$/.test(input.project)) {
    throw new CliError(`--project must be a Jira project key (e.g. ITSM); got "${input.project}".`);
  }
  if (input.issueType.trim().length === 0) {
    throw new CliError("--issueType must be an issue type id (e.g. 10903) or name.");
  }
  const [year, month] = input.month.split("-").map(Number) as [number, number];
  const from = `${input.month}-01`;
  const to = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const issueType = /^\d+$/.test(input.issueType.trim()) ? input.issueType.trim() : quote(input.issueType.trim());
  const completion = quote(COMPLETION_DATE_FIELD);

  const clauses = [
    `project = ${input.project}`,
    `issuetype = ${issueType}`,
    `status = ${quote(input.status ?? DEFAULT_MONTHLY_STATUS)}`,
    `((${completion} >= "${from}" AND ${completion} < "${to}") OR (${completion} is EMPTY AND resolved >= "${from}" AND resolved < "${to}"))`,
  ];
  if (input.extraJql?.trim()) {
    clauses.push(`(${input.extraJql.trim()})`);
  }
  return `${clauses.join(" AND ")} ORDER BY ${completion} ASC`;
}

/** Page through `/rest/api/3/search/jql` (token-based) and return every matching issue key, in order. */
export async function searchIssueKeys(jira: AtlassianRestClient, jql: string): Promise<string[]> {
  const keys: string[] = [];
  const seenTokens = new Set<string>();
  let nextPageToken: string | undefined;
  while (true) {
    const page = await jira.getJson("jira", "/rest/api/3/search/jql", {
      jql,
      fields: "key",
      maxResults: SEARCH_PAGE_SIZE,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
    const issues = firstPresent(page, ["issues"]);
    for (const issue of Array.isArray(issues) ? issues : []) {
      const key = firstString(issue, ["key"]);
      if (key) keys.push(key);
    }
    nextPageToken = firstString(page, ["nextPageToken"]);
    // Stop on the last page, or if Jira ever hands back a token we already used.
    if (firstPresent(page, ["isLast"]) === true || !nextPageToken || seenTokens.has(nextPageToken)) {
      return [...new Set(keys)];
    }
    seenTokens.add(nextPageToken);
  }
}

/**
 * Library form of the monthly mode of `generate-release-notes`: find every
 * completed release in a month, build each one's notes with the single-release
 * pipeline (in parallel, one provider per release), author a month-level
 * summary, and write one JSON pack plus internal and external markdown.
 */
export async function runGenerateMonthlyReleaseNotes(
  input: GenerateMonthlyReleaseNotesInput,
): Promise<GenerateMonthlyReleaseNotesOutput> {
  const progress = input.onProgress ?? (() => undefined);
  const concurrency = Math.min(MAX_MONTHLY_CONCURRENCY, Math.max(1, Math.floor(input.concurrency ?? DEFAULT_MONTHLY_CONCURRENCY)));
  const jql = buildMonthlyJql(input);
  const scope = `${input.project} ${input.month}`;

  const keys = await searchIssueKeys(input.jira, jql);
  progress({ type: "matched", scope, total: keys.length, concurrency });

  const outcomes = await mapWithConcurrency(keys, concurrency, async (key) => {
    const provider = input.providerFactory();
    const startedAt = Date.now();
    progress({ type: "release-started", key });
    try {
      const built = await withTelemetrySession(jiraIssueSessionId(key), () =>
        buildReleaseNotesPack({
          issueKey: key,
          provider,
          llm: input.llm,
          vcsTokens: input.vcsTokens,
          ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
          ...(input.maxLinkedTickets !== undefined ? { maxLinkedTickets: input.maxLinkedTickets } : {}),
        }),
      );
      const { teamTemplate, excludedTickets } = built.pack;
      progress({
        type: "release-finished",
        key,
        ok: true,
        durationMs: Date.now() - startedAt,
        rows: teamTemplate.newFeatures.length + teamTemplate.maintenance.length + teamTemplate.bugFixes.length,
        excluded: excludedTickets.length,
        fallback: Boolean(built.fallbackReason),
      });
      return built;
    } catch (error) {
      progress({ type: "release-finished", key, ok: false, durationMs: Date.now() - startedAt, error: errorMessage(error) });
      throw error;
    } finally {
      await provider.close().catch(() => undefined);
    }
  });

  const warnings: Warning[] = [];
  const releases: ReleaseNotesPack[] = [];
  const failedKeys: string[] = [];
  const fallbackKeys = new Set<string>();
  outcomes.forEach((outcome, index) => {
    const key = keys[index]!;
    if (outcome.ok) {
      releases.push(outcome.value.pack);
      if (outcome.value.fallbackReason) fallbackKeys.add(key);
    } else {
      failedKeys.push(key);
      warnings.push({
        section: "releaseNotes",
        toolName: "release-notes:monthly",
        message: `Could not build release notes for ${key}; skipped: ${errorMessage(outcome.error)}`,
      });
    }
  });
  if (keys.length > 0 && releases.length === 0) {
    throw new CliError(`Release notes could not be built for any of the ${keys.length} matched release(s): ${failedKeys.join(", ")}.`);
  }

  if (releases.length > 0) progress({ type: "summarising", releases: releases.length });
  const { summary, fallbackReason } = await authorMonthlySummary({
    monthLabel: formatMonthLabel(input.month),
    scopeLabel: input.project,
    // Fallback notes carry a canned "automated fallback" summary; give the model only their title.
    releases: releases.map((r) => ({
      title: r.notes.title,
      summary: fallbackKeys.has(r.releaseIssueKey) ? r.notes.title : r.notes.summary,
      highlights: fallbackKeys.has(r.releaseIssueKey) ? [] : r.notes.highlights,
    })),
    llm: input.llm,
  });
  if (fallbackReason) {
    warnings.push({
      section: "releaseNotes",
      toolName: "llm:release-notes-monthly",
      message: `The monthly summary was not authored by the LLM (${fallbackReason}); wrote an automated fallback summary.`,
    });
  }

  const pack: MonthlyReleaseNotesPack = MonthlyReleaseNotesPackSchema.parse({
    schemaVersion: MONTHLY_RELEASE_NOTES_SCHEMA_VERSION,
    kind: "monthly",
    project: input.project,
    issueType: input.issueType,
    month: input.month,
    jql,
    matchedCount: keys.length,
    failedKeys,
    summary,
    releases,
    provenance: {
      generatedAt: new Date().toISOString(),
      llm: { provider: input.llm.provider, model: input.llm.model },
      concurrency,
    },
    warnings,
  });

  const paths = await writeMonthlyReleaseNotesPack(pack, input.outDir);
  return { matchedCount: keys.length, processedCount: releases.length, failedKeys, ...paths };
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MonthlyProgressPrinter {
  onProgress: (event: MonthlyProgressEvent) => void;
  /** Close the bar; safe to call more than once. */
  finish: () => void;
  /** Releases that ended with fallback notes (LLM failure), for the final summary. */
  fallbackKeys: () => string[];
}

/**
 * Render {@link MonthlyProgressEvent}s with a {@link ProgressReporter}: a live
 * bar on a TTY, one line per release elsewhere (CI logs).
 */
export function createMonthlyProgressPrinter(stream: ProgressStream, now?: () => number): MonthlyProgressPrinter {
  let reporter: ProgressReporter | undefined;
  const fallbacks: string[] = [];
  return {
    onProgress: (event) => {
      switch (event.type) {
        case "matched":
          stream.write(`Matched ${event.total} release(s) for ${event.scope}; processing ${event.concurrency} at a time.\n`);
          reporter = new ProgressReporter({ label: event.scope, total: event.total, stream, ...(now ? { now } : {}) });
          break;
        case "release-started":
          reporter?.start();
          break;
        case "release-finished":
          if (event.ok) {
            if (event.fallback) fallbacks.push(event.key);
            const detail = [
              formatDuration(event.durationMs),
              `${event.rows} row(s)`,
              ...(event.excluded > 0 ? [`${event.excluded} excluded`] : []),
              ...(event.fallback ? ["fallback notes"] : []),
            ].join(", ");
            reporter?.complete(event.key, true, detail);
            if (event.fallback) reporter?.note(`! ${event.key}: LLM failed, wrote fallback notes (flagged for review).`);
          } else {
            reporter?.complete(event.key, false, event.error);
          }
          break;
        case "summarising":
          reporter?.finish();
          stream.write(`Writing the month summary over ${event.releases} release(s)...\n`);
          break;
      }
    },
    finish: () => reporter?.finish(),
    fallbackKeys: () => [...fallbacks],
  };
}
