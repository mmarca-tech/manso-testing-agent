import type { ContextProvider } from "../../context/providerRegistry.js";
import {
  CONTEXT_SCHEMA_VERSION,
  ContextPackSchema,
  type Attachment,
  type ConfluencePage,
  type ContextPack,
  type Development,
  type RelatedTicket,
  type TicketLink,
  type Warning,
  type XrayTestCase,
} from "../../domain/contextPack/schema.js";
import { analyzeAttachments } from "../../context/attachmentAnalysis.js";
import { buildEvidenceGraph } from "../../context/evidenceGraph.js";
import { createImageDescriber } from "../../context/visionAnalysis.js";
import type { LlmTextClient } from "../../integrations/llm/types.js";
import type { NormalizedIssue } from "../../domain/tickets/normalizedIssue.js";
import { issueToRelatedTicket, linkToRelatedTicket } from "../../domain/tickets/related.js";
import { isXrayTestLink, issueToXrayTestCase, linkToXrayTestCase } from "../../domain/tickets/xray.js";
import { uniqueBy } from "../../shared/utils.js";

/** Upper bound on how many non-test linked tickets the Researcher expands. */
const MAX_RELATED_TICKETS = 12;

export interface ResearcherInput {
  issueKey: string;
  provider: ContextProvider;
  /** Override the related-ticket fetch budget (default {@link MAX_RELATED_TICKETS}). */
  maxRelatedTickets?: number;
  /**
   * Linked-ticket expansion depth (from `context.linkedTicketDepth`). `0`
   * disables related-ticket expansion entirely; `≥1` expands direct links
   * (the current single-level behaviour). Defaults to expanding.
   */
  linkedTicketDepth?: number;
  /**
   * Whether to download + analyze attachment content (from
   * `context.attachmentUnderstanding`). When `false`, attachments are still
   * listed (metadata) but never fetched or summarised. Defaults to `true`.
   */
  attachmentUnderstanding?: boolean;
  /** Vision-capable LLM; when present, image attachments get a vision summary. */
  llm?: LlmTextClient;
}

/**
 * Researcher sub-agent (deterministic form, M4): assemble a validated
 * {@link ContextPack} by calling every provider section, deduping, and
 * collecting provenance + warnings. Becomes tool-using in M10.
 */
export async function runResearcher(input: ResearcherInput): Promise<ContextPack> {
  const { issueKey, provider } = input;
  const warnings: Warning[] = [];

  const issue = await provider.getIssue(issueKey);

  const comments = uniqueBy(
    [...issue.comments, ...(await optionalSection("comments", warnings, () => provider.getComments(issueKey), []))],
    (comment) => comment.id ?? comment.url ?? `${comment.createdAt ?? ""}:${comment.body.slice(0, 80)}`,
  );

  const rawAttachments = uniqueBy(
    await optionalSection<Attachment[]>("attachments", warnings, () => provider.getAttachments(issueKey), []),
    (attachment) => attachment.id ?? attachment.url ?? attachment.filename,
  );
  // Honour context.attachmentUnderstanding: when disabled, keep attachment
  // metadata but never download or summarise their content.
  const understandAttachments = input.attachmentUnderstanding ?? true;
  const attachments = understandAttachments
    ? await analyzeAttachments({
        attachments: rawAttachments,
        warnings,
        ...(provider.fetchAttachmentContent
          ? { fetchContent: (attachment) => provider.fetchAttachmentContent!(attachment) }
          : {}),
        ...(input.llm ? { describeImage: createImageDescriber(input.llm) } : {}),
      })
    : rawAttachments;

  const linkedIssues = uniqueBy(
    [
      ...issue.linkedIssues,
      ...(await optionalSection("linkedIssues", warnings, () => provider.getLinkedIssues(issueKey), [])),
    ],
    (link) => link.issueKey ?? link.url,
  );

  const development = await optionalSection<Development>(
    "development",
    warnings,
    () => provider.getDevelopmentLinks(issueKey),
    { branches: [], pullRequests: [] },
  );

  const confluencePages = uniqueBy(
    await optionalSection<ConfluencePage[]>("confluencePages", warnings, () => provider.getConfluencePages(issueKey), []),
    (page) => page.url ?? page.id ?? page.title,
  );

  const xrayTestCases = uniqueBy(await fetchXrayTestCases(linkedIssues, provider, warnings), (test) => test.key);

  // Honour context.linkedTicketDepth: 0 disables related-ticket expansion;
  // ≥1 expands direct links (single-level). Deeper recursion is future work.
  const expandRelated = (input.linkedTicketDepth ?? 1) > 0;
  const relatedTickets = expandRelated
    ? uniqueBy(
        await fetchRelatedTickets(linkedIssues, provider, warnings, input.maxRelatedTickets ?? MAX_RELATED_TICKETS),
        (related) => related.key,
      )
    : [];

  const baseContext: ContextPack = {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    ticket: {
      ...issue.ticket,
      links: linkedIssues,
    },
    description: issue.description,
    comments,
    attachments,
    xrayTestCases,
    ...(relatedTickets.length > 0 ? { relatedTickets } : {}),
    development,
    confluencePages,
    provenance: {
      generatedAt: new Date().toISOString(),
      issueKey,
      source: "jira-rest",
      tools: provider.getProvenance(),
    },
    warnings: [...warnings, ...provider.getWarnings()],
  };

  const context: ContextPack = {
    ...baseContext,
    evidenceGraph: buildEvidenceGraph(baseContext),
  };

  return ContextPackSchema.parse(context);
}

async function fetchXrayTestCases(
  linkedIssues: TicketLink[],
  provider: ContextProvider,
  warnings: Warning[],
): Promise<XrayTestCase[]> {
  const testLinks = linkedIssues.filter(isXrayTestLink);
  const output: XrayTestCase[] = [];

  for (const link of testLinks) {
    if (!link.issueKey) {
      const fallback = linkToXrayTestCase(link);
      if (fallback) {
        output.push(fallback);
      }
      continue;
    }

    try {
      const testIssue: NormalizedIssue = await provider.getIssue(link.issueKey);
      output.push(issueToXrayTestCase(testIssue, link.relationship));
    } catch (error) {
      const fallback = linkToXrayTestCase(link);
      if (fallback) {
        output.push(fallback);
      }

      warnings.push({
        section: "xrayTestCases",
        message: `Could not fetch linked Xray test ${link.issueKey}: ${errorMessage(error)}`,
      });
    }
  }

  return output;
}

/**
 * Expand the bodies of non-test linked tickets (epic/parent, subtasks, related
 * stories/bugs) so the design has fuller requirement context. Bounded by
 * {@link MAX_RELATED_TICKETS}; when the cap is hit, the remaining links are
 * recorded as a warning rather than silently dropped.
 */
async function fetchRelatedTickets(
  linkedIssues: TicketLink[],
  provider: ContextProvider,
  warnings: Warning[],
  maxTickets: number,
): Promise<RelatedTicket[]> {
  const relatedLinks = linkedIssues.filter((link) => Boolean(link.issueKey) && !isXrayTestLink(link));
  const output: RelatedTicket[] = [];
  let skipped = 0;

  for (const link of relatedLinks) {
    const issueKey = link.issueKey;
    if (!issueKey) continue;

    if (output.length >= maxTickets) {
      skipped += 1;
      continue;
    }

    try {
      const relatedIssue: NormalizedIssue = await provider.getIssue(issueKey);
      output.push(issueToRelatedTicket(relatedIssue, link.relationship));
    } catch (error) {
      const fallback = linkToRelatedTicket(link);
      if (fallback) {
        output.push(fallback);
      }
      warnings.push({
        section: "relatedTickets",
        message: `Could not fetch related ticket ${issueKey}: ${errorMessage(error)}`,
      });
    }
  }

  if (skipped > 0) {
    warnings.push({
      section: "relatedTickets",
      message: `Related-ticket fetch capped at ${maxTickets}; ${skipped} further linked ticket(s) were not expanded.`,
    });
  }

  return output;
}

async function optionalSection<T>(
  section: string,
  warnings: Warning[],
  action: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    warnings.push({
      section,
      message: errorMessage(error),
    });
    return fallback;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
