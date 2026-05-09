import type { ContextPack, TicketLink, Warning } from "../../domain/contextPack/schema.js";
import { RELEASE_NOTES_SCHEMA_VERSION, ReleaseNotesPackSchema } from "../../domain/releaseNotes/schema.js";
import type { ReleaseNotes, ReleaseNotesLinkedTicket, ReleaseNotesPack } from "../../domain/releaseNotes/schema.js";
import { uniqueBy } from "../../shared/utils.js";
import { extractTicketContext } from "../ticket-context/extractor.js";
import type { TicketSource } from "../ticket-context/ticketSource.js";
import type { ReleaseNotesSummarizer } from "./summarizer.js";

interface ExtractReleaseNotesOptions {
  maxLinkedTickets?: number;
  onProgress?: (message: string) => void;
}

export async function extractReleaseNotes(
  issueKey: string,
  source: TicketSource,
  summarizer: ReleaseNotesSummarizer,
  options: ExtractReleaseNotesOptions = {},
): Promise<ReleaseNotesPack> {
  const warnings: Warning[] = [];

  options.onProgress?.(`Extracting release ticket ${issueKey}.`);
  const releaseContext = await extractTicketContext(issueKey, source);
  const linkedIssueCandidates = collectLinkedIssueCandidates(releaseContext, warnings);
  const linkedIssueLinks = limitLinkedTickets(linkedIssueCandidates, options.maxLinkedTickets, warnings);
  const linkedTickets: ReleaseNotesLinkedTicket[] = [];

  options.onProgress?.(`Found ${linkedIssueCandidates.length} linked Jira ticket(s).`);
  let index = 0;
  for (const link of linkedIssueLinks) {
    index += 1;
    const linkedIssueKey = link.issueKey;
    if (!linkedIssueKey) {
      continue;
    }

    try {
      options.onProgress?.(`Extracting linked ticket ${index}/${linkedIssueLinks.length}: ${linkedIssueKey}.`);
      const context = await extractTicketContext(linkedIssueKey, source);
      linkedTickets.push({
        ...(link.relationship ? { relationship: link.relationship } : {}),
        context,
      });
    } catch (error) {
      warnings.push({
        section: "linkedTickets",
        message: `Could not extract linked ticket ${linkedIssueKey}: ${errorMessage(error)}`,
      });
    }
  }

  options.onProgress?.(`Generating release notes from ${linkedTickets.length} linked ticket context(s).`);
  const notes = await summarizeReleaseNotes(releaseContext, linkedTickets, summarizer, warnings);

  const pack: ReleaseNotesPack = {
    schemaVersion: RELEASE_NOTES_SCHEMA_VERSION,
    releaseTicket: {
      key: releaseContext.ticket.key,
      title: releaseContext.ticket.title,
      ...(releaseContext.ticket.issueType ? { issueType: releaseContext.ticket.issueType } : {}),
      ...(releaseContext.ticket.status ? { status: releaseContext.ticket.status } : {}),
      ...(releaseContext.ticket.url ? { url: releaseContext.ticket.url } : {}),
    },
    linkedTickets,
    notes,
    provenance: {
      generatedAt: new Date().toISOString(),
      issueKey,
      source: source.getSourceName(),
      llm: {
        provider: summarizer.provider,
        model: summarizer.model,
      },
      tools: [...source.getProvenance(), ...summarizer.getProvenance()],
    },
    warnings: collectWarnings(warnings, releaseContext, linkedTickets, summarizer, source),
  };

  return ReleaseNotesPackSchema.parse(pack);
}

function collectLinkedIssueCandidates(releaseContext: ContextPack, warnings: Warning[]): TicketLink[] {
  const releaseIssueKey = releaseContext.ticket.key.toLowerCase();
  const linksWithKeys = releaseContext.ticket.links.filter((link) => link.issueKey && link.issueKey.toLowerCase() !== releaseIssueKey);
  const linksWithoutKeys = releaseContext.ticket.links.filter((link) => !link.issueKey && link.url);

  for (const link of linksWithoutKeys) {
    warnings.push({
      section: "linkedTickets",
      message: `Skipping linked item without a Jira issue key: ${link.title ?? link.url ?? "unknown link"}`,
    });
  }

  return uniqueBy(linksWithKeys, (link) => link.issueKey);
}

function limitLinkedTickets(links: TicketLink[], maxLinkedTickets: number | undefined, warnings: Warning[]): TicketLink[] {
  if (maxLinkedTickets === undefined || links.length <= maxLinkedTickets) {
    return links;
  }

  warnings.push({
    section: "linkedTickets",
    message: `Limited linked ticket extraction to ${maxLinkedTickets} of ${links.length} linked Jira ticket(s).`,
  });
  return links.slice(0, maxLinkedTickets);
}

async function summarizeReleaseNotes(
  releaseContext: ContextPack,
  linkedTickets: ReleaseNotesLinkedTicket[],
  summarizer: ReleaseNotesSummarizer,
  warnings: Warning[],
): Promise<ReleaseNotes> {
  try {
    return await summarizer.summarize({ releaseContext, linkedTickets });
  } catch (error) {
    warnings.push({
      section: "llm",
      message: `Could not generate release notes: ${errorMessage(error)}`,
    });
    return fallbackReleaseNotes(releaseContext, linkedTickets);
  }
}

function fallbackReleaseNotes(releaseContext: ContextPack, linkedTickets: ReleaseNotesLinkedTicket[]): ReleaseNotes {
  const ticketSummaries = linkedTickets.map(({ relationship, context }) => ({
    key: context.ticket.key,
    title: context.ticket.title,
    ...(context.ticket.issueType ? { issueType: context.ticket.issueType } : {}),
    ...(context.ticket.status ? { status: context.ticket.status } : {}),
    ...(relationship ? { relationship } : {}),
    summary: firstSentence(context.description.text) || context.ticket.title,
    risks: [],
    testingNotes: [],
  }));

  return {
    title: `Release Notes for ${releaseContext.ticket.key}`,
    audience: "Release stakeholders, QA, support, and delivery teams.",
    summary:
      linkedTickets.length === 0
        ? "No linked Jira tickets were found for this release ticket."
        : `Release notes were generated from ${linkedTickets.length} linked Jira ticket(s). The LLM summary was unavailable, so this fallback keeps the source ticket details visible.`,
    highlights: linkedTickets.map(({ context }) => `${context.ticket.key}: ${context.ticket.title}`),
    changeItems: linkedTickets.map(({ context }) => ({
      area: context.ticket.components[0] ?? context.ticket.issueType ?? "General",
      description: firstSentence(context.description.text) || context.ticket.title,
      impact: "Review the linked ticket context for release impact details.",
      tickets: [context.ticket.key],
    })),
    deploymentNotes: [],
    testingNotes: [],
    knownRisks: [],
    ticketSummaries,
  };
}

function firstSentence(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  return normalized.split(/(?<=[.!?])\s+/)[0]?.slice(0, 500) ?? normalized.slice(0, 500);
}

function collectWarnings(
  warnings: Warning[],
  releaseContext: ContextPack,
  linkedTickets: ReleaseNotesLinkedTicket[],
  summarizer: ReleaseNotesSummarizer,
  source: TicketSource,
): Warning[] {
  return uniqueBy(
    [
      ...warnings,
      ...releaseContext.warnings,
      ...linkedTickets.flatMap((ticket) => ticket.context.warnings),
      ...source.getWarnings(),
      ...summarizer.getWarnings(),
    ],
    (warning) => `${warning.section}:${warning.toolName ?? ""}:${warning.message}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
