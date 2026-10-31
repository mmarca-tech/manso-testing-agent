import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runResearcher } from "../agents/researcher/index.js";
import { summarisePullRequest, type PullRequestUnderstanding } from "../agents/pullRequestSummariser/index.js";
import { authorReleaseNotes, formatReleaseNotesAsComment, type LinkedTicketForReleaseNotes } from "../agents/releaseNotesAuthor/index.js";
import { assessEligibility, browseUrl, buildTeamTemplate } from "../agents/releaseNotesAuthor/teamTemplate.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../config/runtimeConfig.js";
import { auditLogPath, emitAudit } from "../policy/auditLog.js";
import type { ContextProvider } from "../context/providerRegistry.js";
import { createJiraRestProviderFromRuntime } from "../context/providers/jiraRestProvider.js";
import type { ContextPack, Warning } from "../domain/contextPack/schema.js";
import {
  RELEASE_NOTES_SCHEMA_VERSION,
  ReleaseNotesPackSchema,
  type ExcludedTicket,
  type ReleaseNotesPack,
  type TeamReleaseNotes,
} from "../domain/releaseNotes/schema.js";
import { AtlassianRestClient } from "../integrations/atlassianRest/client.js";
import { createLlmTextClient } from "../integrations/llm/factory.js";
import { jiraIssueSessionId, withTelemetrySession } from "../integrations/llm/telemetry/observability.js";
import type { LlmTextClient } from "../integrations/llm/types.js";
import { resolveVcsAdapter, vcsTokensFromRuntime, type VcsTokens } from "../integrations/vcs/resolve.js";
import type { VcsAdapterKind } from "../integrations/vcs/adapter.js";
import { writeReleaseNotesPack } from "../output/release-notes/writer.js";
import { CliError } from "../shared/cli.js";
import { formatDuration } from "../shared/progress.js";
import {
  createMonthlyProgressPrinter,
  MAX_MONTHLY_CONCURRENCY,
  parseMonth,
  runGenerateMonthlyReleaseNotes,
} from "./generateMonthlyReleaseNotes.js";
import type { CommandModule } from "./main.js";

const HELP = `manso generate-release-notes - generate release notes for a Jira release ticket,
or a monthly summary of every release completed in a month.

Usage:
  manso generate-release-notes --issue <KEY> [options]
  manso generate-release-notes --project <KEY> --issueType <ID|NAME> --date <MM/YY> [options]

Single release:
  --issue <KEY>     Jira issue key for the release ticket.

Monthly summary (all three required):
  --project <KEY>   Jira project key, e.g. ITSM.
  --issueType <ID|NAME>
                    Release issue type, e.g. 10903 ([System] Change).
  --date <MM/YY>    Month, e.g. 10/26 for October 2026 (also MM/YYYY, YYYY-MM).
                    A release belongs to the month of its "Change completion
                    date", or of its resolution date when that is empty.
  --status <NAME>   Status that means successfully completed. Default: Completed.
  --jql "<JQL>"     Extra JQL ANDed onto the query, e.g. a team or service filter.
                    Without it, every matching release is processed (no cap).
  --concurrency <n> Releases processed in parallel (1-8). Default: 4. Saves time,
                    not tokens: each release still costs its own LLM call(s).

Common options:
  --out <dir>       Output root directory. Defaults to ./out.
  --repo <path>     Path to a local checkout of the repo whose PRs are linked
                    (used to detect the Azure DevOps/GitHub remote for PR diff
                    analysis). Optional — PR analysis is skipped with a warning
                    if omitted or no VCS token is configured.
  --max-linked <n>  Cap on how many linked tickets to expand. Defaults to 12.
  --config <path>   Optional JSON runtime-config file for non-secret overrides.
  --comment         Post the generated release notes as a Jira comment on the
                    release ticket. Single-release mode only.
  --dry-run         Skip the Jira comment post; still write local files.
  -h, --help        Show this help.

This command:
  1. Fetches the release ticket and its linked tickets' context (via the
     Context Layer / Researcher — ticket body, Confluence pages, dev links).
  2. Excludes linked tickets that are not done, or were resolved without
     delivery (Won't Do, Duplicate, ...), and lists them for the reviewer.
  3. For included tickets with linked pull requests, fetches each PR's changed
     files (and diff, where the VCS platform supports it) and summarises them.
  4. Asks an LLM to draft the notes and classify each ticket as New Feature,
     Maintenance or Bug fix. Ticket links, product affected (Affected services
     + components), fix version and release dates come from Jira, not the LLM.
  5. Writes under --out/<ISSUE-KEY>/:
       release-notes.json         full pack
       release-notes.md           internal team template, with ticket links
       release-notes.external.md  external-facing, no ticket keys or links
  6. Optionally posts the internal notes as a Jira comment (--comment).

Monthly mode runs steps 1-4 for every matched release (in parallel), adds one
month-level LLM summary, and writes the same three files under
--out/<PROJECT>-<YYYY-MM>/, with every release in the JSON.
`;

export interface GenerateReleaseNotesInput {
  issueKey: string;
  outDir: string;
  provider: ContextProvider;
  llm: LlmTextClient;
  jira: AtlassianRestClient;
  repoRoot?: string;
  vcsTokens: VcsTokens;
  maxLinkedTickets?: number;
  postComment?: boolean;
  dryRun?: boolean;
  sessionId?: string;
}

/** What one release needs to become a {@link ReleaseNotesPack}; no output or posting concerns. */
export type BuildReleaseNotesPackInput = Pick<
  GenerateReleaseNotesInput,
  "issueKey" | "provider" | "llm" | "repoRoot" | "vcsTokens" | "maxLinkedTickets"
>;

export interface BuildReleaseNotesPackResult {
  /** Validated pack with `provenance.commentPosted: false`; the caller decides about posting. */
  pack: ReleaseNotesPack;
  release: TeamReleaseNotes;
  fallbackReason?: string;
}

export interface GenerateReleaseNotesOutput {
  notesTitle: string;
  linkedTicketCount: number;
  pullRequestsAnalyzed: number;
  excludedTicketCount: number;
  commentPosted: boolean;
  jsonPath: string;
  markdownPath: string;
  externalMarkdownPath: string;
}

/** Matches an Azure DevOps PR URL of the form .../_git/<repo>/pullrequest/<id>. */
const AZURE_PR_URL_RE = /_git\/[^/]+\/pullrequest\/(\d+)/i;
/** Matches a GitHub PR URL of the form https://github.com/<owner>/<repo>/pull/<id>. */
const GITHUB_PR_URL_RE = /^https?:\/\/[^/]*github[^/]*\/[^/]+\/[^/]+\/pull\/(\d+)/i;
const MAX_PRS_PER_TICKET = 5;

/**
 * Library form of `generate-release-notes`. Fetches the release ticket's and
 * its linked tickets' context via the Context Layer, summarises any linked
 * pull requests, asks an LLM to author audience-facing release notes, writes
 * them to disk, and optionally posts them as a Jira comment.
 */
export async function runGenerateReleaseNotes(input: GenerateReleaseNotesInput): Promise<GenerateReleaseNotesOutput> {
  const sessionId = input.sessionId ?? jiraIssueSessionId(input.issueKey);
  return withTelemetrySession(sessionId, () => runGenerateReleaseNotesInner(input));
}

async function runGenerateReleaseNotesInner(input: GenerateReleaseNotesInput): Promise<GenerateReleaseNotesOutput> {
  const { pack: draft, release, fallbackReason } = await buildReleaseNotesPack(input);
  if (fallbackReason) {
    console.error(`Warning: release notes were not authored by the LLM (${fallbackReason}); wrote an automated fallback summary.`);
  }
  const warnings: Warning[] = [];

  // Post the comment (if requested) BEFORE writing files, so the persisted
  // pack's provenance.commentPosted reflects the actual Jira post outcome.
  // Fallback notes are never posted: they are not audience-ready release notes.
  let commentPosted = false;
  if (input.postComment) {
    if (fallbackReason) {
      console.error(`Skipping Jira comment on ${input.issueKey}: fallback release notes are not posted.`);
    } else if (input.dryRun) {
      console.error(`Dry run: would post release notes comment to ${input.issueKey}.`);
    } else {
      try {
        await input.jira.postJson(
          "jira",
          `/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/comment`,
          { body: formatReleaseNotesAsComment(release) },
        );
        commentPosted = true;
        console.error(`Posted release notes comment on ${input.issueKey}.`);
      } catch (error) {
        console.error(`Failed to post comment: ${errorMessage(error)}`);
        warnings.push({
          section: "releaseNotes",
          toolName: "jira:comment",
          message: `Failed to post comment: ${errorMessage(error)}`,
        });
      }
    }
  }

  const pack: ReleaseNotesPack = ReleaseNotesPackSchema.parse({
    ...draft,
    provenance: { ...draft.provenance, commentPosted },
    warnings: [...draft.warnings, ...warnings],
  });

  const { jsonPath, markdownPath, externalMarkdownPath } = await writeReleaseNotesPack(pack, input.outDir);

  return {
    notesTitle: pack.notes.title,
    linkedTicketCount: pack.linkedTicketKeys.length,
    pullRequestsAnalyzed: pack.pullRequestsAnalyzed,
    excludedTicketCount: pack.excludedTickets.length,
    commentPosted,
    jsonPath,
    markdownPath,
    externalMarkdownPath,
  };
}

/**
 * Build one release's {@link ReleaseNotesPack}: fetch the release ticket and
 * its linked tickets, exclude undelivered work, summarise linked PRs, author
 * the notes and assemble the team template. Writes nothing and posts nothing,
 * so it is safe to run for many releases (see the monthly mode).
 */
export async function buildReleaseNotesPack(input: BuildReleaseNotesPackInput): Promise<BuildReleaseNotesPackResult> {
  const warnings: Warning[] = [];

  const releaseContext = await runResearcher({
    issueKey: input.issueKey,
    provider: input.provider,
    llm: input.llm,
    maxRelatedTickets: input.maxLinkedTickets ?? 12,
  });

  // Resolve the VCS adapter once up front; PRs are optional context, never fatal.
  const vcsResolution = input.repoRoot ? await resolveVcsAdapter(input.repoRoot, input.vcsTokens) : undefined;
  if (!input.repoRoot) {
    warnings.push({
      section: "releaseNotes",
      toolName: "vcs",
      message: "No --repo provided; skipping pull request analysis.",
    });
  } else if (!vcsResolution?.ok) {
    warnings.push({
      section: "releaseNotes",
      toolName: "vcs",
      message: `Could not resolve a VCS adapter for --repo; skipping pull request analysis: ${vcsResolution?.reason ?? "unknown reason"}`,
    });
  }

  const linkedTickets: LinkedTicketForReleaseNotes[] = [];
  const excludedTickets: ExcludedTicket[] = [];
  let pullRequestsAnalyzed = 0;

  for (const relatedTicket of releaseContext.relatedTickets ?? []) {
    let linkedContext: ContextPack;
    try {
      linkedContext = await runResearcher({
        issueKey: relatedTicket.key,
        provider: input.provider,
        llm: input.llm,
        linkedTicketDepth: 0,
      });
    } catch (error) {
      warnings.push({
        section: "releaseNotes",
        toolName: "researcher",
        message: `Could not fetch context for linked ticket ${relatedTicket.key}; skipped: ${errorMessage(error)}`,
      });
      continue;
    }

    // Exclude before PR analysis: unreleased work must not reach the notes, and
    // there is no point paying for its diff summaries.
    const eligibility = assessEligibility(linkedContext.ticket);
    if (!eligibility.eligible) {
      excludedTickets.push({
        key: linkedContext.ticket.key,
        title: linkedContext.ticket.title,
        ...(linkedContext.ticket.status ? { status: linkedContext.ticket.status } : {}),
        reason: eligibility.reason,
      });
      continue;
    }

    const prUnderstandings: PullRequestUnderstanding[] = [];

    if (vcsResolution?.ok) {
      const pullRequests = linkedContext.development.pullRequests;
      const toAnalyze = pullRequests.slice(0, MAX_PRS_PER_TICKET);
      if (pullRequests.length > MAX_PRS_PER_TICKET) {
        warnings.push({
          section: "releaseNotes",
          toolName: "vcs",
          message: `${relatedTicket.key} has ${pullRequests.length} linked pull request(s); only the first ${MAX_PRS_PER_TICKET} were analyzed.`,
        });
      }

      for (const pr of toAnalyze) {
        const prId = extractPrId(pr.url, vcsResolution.kind);
        if (prId === undefined) {
          warnings.push({
            section: "releaseNotes",
            toolName: "vcs",
            message: `Could not extract a pull request id from URL for "${pr.title}" on ${relatedTicket.key}; skipped.`,
          });
          continue;
        }

        if (!vcsResolution.adapter.getPullRequestDiff) {
          warnings.push({
            section: "releaseNotes",
            toolName: "vcs",
            message: `VCS adapter (${vcsResolution.kind}) does not support fetching PR diffs; skipped PR "${pr.title}".`,
          });
          continue;
        }

        let diff;
        try {
          diff = await vcsResolution.adapter.getPullRequestDiff(prId);
        } catch (error) {
          warnings.push({
            section: "releaseNotes",
            toolName: "vcs",
            message: `Failed to fetch diff for PR "${pr.title}" (#${prId}); skipped: ${errorMessage(error)}`,
          });
          continue;
        }

        if (diff.allChangesIncluded === false || (diff.warnings?.length ?? 0) > 0) {
          warnings.push({
            section: "releaseNotes",
            toolName: "vcs",
            message: `Diff for PR "${pr.title}" (#${prId}) is incomplete; its summary may be partial: ${(diff.warnings ?? []).join(" ") || "not all changes were returned."}`,
          });
        }

        try {
          const understanding = await summarisePullRequest({
            pullRequestTitle: pr.title,
            ticketTitle: relatedTicket.title,
            diff,
            llm: input.llm,
          });
          prUnderstandings.push(understanding);
          pullRequestsAnalyzed += 1;
        } catch (error) {
          warnings.push({
            section: "releaseNotes",
            toolName: "llm:pr-summary",
            message: `Failed to summarise PR "${pr.title}"; skipped: ${errorMessage(error)}`,
          });
        }
      }
    }

    linkedTickets.push({ contextPack: linkedContext, prUnderstandings });
  }

  const { notes, fallbackReason } = await authorReleaseNotes({ releaseContext, linkedTickets, llm: input.llm });
  if (fallbackReason) {
    // Not printed here: in monthly mode a progress bar owns the terminal. Callers report it.
    const message = `Release notes for ${input.issueKey} were not authored by the LLM (${fallbackReason}); wrote an automated fallback summary.`;
    warnings.push({ section: "releaseNotes", toolName: "llm:release-notes", message });
  }

  const template = buildTeamTemplate({
    releaseTicket: releaseContext.ticket,
    tickets: linkedTickets.map((t) => t.contextPack.ticket),
    // Fallback entries are empty, so every row is classified by issue type and flagged.
    entries: notes.releaseEntries,
    hadLinkedTickets: (releaseContext.relatedTickets ?? []).length > 0,
  });
  // Per-ticket "no LLM entry" warnings are expected on a fallback run; the fallback warning covers them.
  if (!fallbackReason) warnings.push(...template.warnings);
  const release: TeamReleaseNotes = {
    notes,
    releaseMetadata: template.releaseMetadata,
    teamTemplate: template.teamTemplate,
    excludedTickets,
  };

  const releaseTicket = releaseContext.ticket;
  const pack: ReleaseNotesPack = ReleaseNotesPackSchema.parse({
    schemaVersion: RELEASE_NOTES_SCHEMA_VERSION,
    releaseIssueKey: input.issueKey,
    releaseTicket: {
      title: releaseTicket.title,
      ...(browseUrl(releaseTicket) ? { url: browseUrl(releaseTicket) } : {}),
      ...(releaseTicket.issueType ? { issueType: releaseTicket.issueType } : {}),
      ...(releaseTicket.status ? { status: releaseTicket.status } : {}),
      ...(releaseTicket.completedAt ? { completedAt: releaseTicket.completedAt } : {}),
    },
    ...release,
    linkedTicketKeys: linkedTickets.map((t) => t.contextPack.ticket.key),
    pullRequestsAnalyzed,
    provenance: {
      generatedAt: new Date().toISOString(),
      llm: { provider: input.llm.provider, model: input.llm.model },
      commentPosted: false,
    },
    warnings: [...warnings, ...releaseContext.warnings],
  });

  return { pack, release, ...(fallbackReason ? { fallbackReason } : {}) };
}

function extractPrId(url: string | undefined, kind: VcsAdapterKind): number | undefined {
  if (!url) return undefined;
  const pattern = kind === "github" ? GITHUB_PR_URL_RE : kind === "azure-devops" ? AZURE_PR_URL_RE : undefined;
  const match = pattern?.exec(url);
  if (!match || !match[1]) return undefined;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildLlmClient(runtime: RuntimeConfig): LlmTextClient | undefined {
  if (!runtime.llm) {
    return undefined;
  }
  return createLlmTextClient(
    runtime.llm,
    runtime.observability ? { telemetry: runtime.observability.telemetry } : {},
  );
}

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      issue: { type: "string" },
      project: { type: "string" },
      issueType: { type: "string" },
      date: { type: "string" },
      status: { type: "string" },
      jql: { type: "string" },
      concurrency: { type: "string" },
      out: { type: "string" },
      repo: { type: "string" },
      "max-linked": { type: "string" },
      config: { type: "string" },
      comment: { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const monthlyFlags = [values.project, values.issueType, values.date];
  const monthly = monthlyFlags.some((v) => v !== undefined);
  if (monthly && values.issue) {
    throw new CliError("Use either --issue (one release) or --project/--issueType/--date (monthly), not both.");
  }
  if (monthly && monthlyFlags.some((v) => v === undefined)) {
    throw new CliError("Monthly mode needs all of --project, --issueType and --date.");
  }
  if (!monthly && !values.issue) {
    throw new CliError(
      "--issue, or --project/--issueType/--date, is required. Run 'manso generate-release-notes --help' for usage.",
    );
  }
  if (monthly && values.comment) {
    throw new CliError("--comment is not supported in monthly mode: there is no single ticket to post to.");
  }
  if (!monthly && (values.status || values.jql || values.concurrency)) {
    throw new CliError("--status, --jql and --concurrency only apply to monthly mode.");
  }
  // Validate before any network call.
  const month = monthly ? parseMonth(values.date!) : undefined;
  const concurrency = values.concurrency !== undefined ? Number(values.concurrency) : undefined;
  if (
    concurrency !== undefined &&
    (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_MONTHLY_CONCURRENCY)
  ) {
    throw new CliError(
      `--concurrency must be an integer between 1 and ${MAX_MONTHLY_CONCURRENCY}; got "${values.concurrency}".`,
    );
  }

  const outDir = resolve(values.out ?? "./out");
  const runtime = await loadRuntimeConfig(values.config ? { configPath: values.config } : {});
  const provider = createJiraRestProviderFromRuntime(runtime);
  if (!provider) {
    throw new CliError(
      "Jira credentials are not configured. Set JIRA_URL, JIRA_USERNAME, and JIRA_API_TOKEN.",
    );
  }

  const llm = buildLlmClient(runtime);
  if (!llm) {
    throw new CliError(
      "An LLM API key is required for release notes generation. Set LLM_API_KEY or OPENAI_API_KEY.",
    );
  }

  if (!runtime.jiraRest) {
    throw new CliError(
      "Jira REST credentials are required. Set JIRA_URL, JIRA_USERNAME, and JIRA_API_TOKEN.",
    );
  }

  const jira = new AtlassianRestClient({
    jira: {
      baseUrl: runtime.jiraRest.jiraUrl,
      username: runtime.jiraRest.jiraUsername,
      apiToken: runtime.jiraRest.jiraApiToken,
    },
  });

  const vcsTokens = vcsTokensFromRuntime(runtime);
  const repoRoot = values.repo ? resolve(values.repo) : undefined;
  const maxLinked = values["max-linked"] ? Number(values["max-linked"]) : undefined;
  const maxLinkedTickets = maxLinked !== undefined && Number.isFinite(maxLinked) ? { maxLinkedTickets: maxLinked } : {};
  const dryRun = values["dry-run"] ?? false;
  const postComment = values.comment ?? false;
  const auditPath = auditLogPath(outDir);

  if (monthly) {
    // Each release gets its own provider (see runGenerateMonthlyReleaseNotes); this one is not needed.
    await provider.close();
    const project = values.project!;
    const target = `${project} ${month!}`;
    await emitAudit({ path: auditPath, action: "run.started", actor: "generate-release-notes", target, redactPatterns: [] });
    console.error(`Generate Release Notes (monthly): searching ${target}...`);
    console.error(`LLM: ${llm.provider} ${llm.model}`);

    const printer = createMonthlyProgressPrinter(process.stderr);
    const startedAt = Date.now();
    let result;
    try {
      result = await runGenerateMonthlyReleaseNotes({
        project,
        issueType: values.issueType!,
        month: month!,
        ...(values.status ? { status: values.status } : {}),
        ...(values.jql ? { extraJql: values.jql } : {}),
        ...(concurrency !== undefined ? { concurrency } : {}),
        outDir,
        providerFactory: () => createJiraRestProviderFromRuntime(runtime)!,
        llm,
        jira,
        ...(repoRoot ? { repoRoot } : {}),
        vcsTokens,
        ...maxLinkedTickets,
        onProgress: printer.onProgress,
      });
    } finally {
      printer.finish();
    }
    const fallbackKeys = printer.fallbackKeys();

    await emitAudit({
      path: auditPath,
      action: "run.completed",
      actor: "generate-release-notes",
      target,
      detail: { matched: result.matchedCount, processed: result.processedCount, failed: result.failedKeys.length },
      redactPatterns: [],
    });

    console.log(`\nMonthly Release Notes Generated:`);
    console.log(`  Releases matched: ${result.matchedCount}`);
    console.log(`  Releases processed: ${result.processedCount}`);
    console.log(`  Failed: ${result.failedKeys.length > 0 ? result.failedKeys.join(", ") : 0}`);
    console.log(`  Fallback notes (LLM failed, review these): ${fallbackKeys.length > 0 ? fallbackKeys.join(", ") : 0}`);
    console.log(`  Took: ${formatDuration(Date.now() - startedAt)}`);
    console.log(`  JSON: ${result.jsonPath}`);
    console.log(`  Markdown (internal): ${result.markdownPath}`);
    console.log(`  Markdown (external): ${result.externalMarkdownPath}`);
    return 0;
  }

  const issueKey = values.issue!;
  await emitAudit({ path: auditPath, action: "run.started", actor: "generate-release-notes", target: issueKey, redactPatterns: [] });

  console.error(`Generate Release Notes: fetching context for ${issueKey}...`);
  console.error(`LLM: ${llm.provider} ${llm.model}`);

  try {
    const result = await runGenerateReleaseNotes({
      issueKey,
      outDir,
      provider,
      llm,
      jira,
      ...(repoRoot ? { repoRoot } : {}),
      vcsTokens,
      ...maxLinkedTickets,
      postComment,
      dryRun,
    });

    await emitAudit({
      path: auditPath,
      action: "run.completed",
      actor: "generate-release-notes",
      target: issueKey,
      detail: {
        linkedTickets: result.linkedTicketCount,
        pullRequestsAnalyzed: result.pullRequestsAnalyzed,
        excludedTickets: result.excludedTicketCount,
        commentPosted: result.commentPosted,
      },
      redactPatterns: [],
    });

    console.log(`\nRelease Notes Generated:`);
    console.log(`  Title: ${result.notesTitle}`);
    console.log(`  Linked tickets: ${result.linkedTicketCount}`);
    console.log(`  Pull requests analyzed: ${result.pullRequestsAnalyzed}`);
    console.log(`  Excluded tickets: ${result.excludedTicketCount}`);
    console.log(`  Comment posted: ${result.commentPosted}`);
    console.log(`  JSON: ${result.jsonPath}`);
    console.log(`  Markdown (internal): ${result.markdownPath}`);
    console.log(`  Markdown (external): ${result.externalMarkdownPath}`);

    return 0;
  } finally {
    await provider.close();
  }
}

const command: CommandModule = { run };
export default command;
