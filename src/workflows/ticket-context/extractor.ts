import { CONTEXT_SCHEMA_VERSION, ContextPackSchema } from "../../domain/contextPack/schema.js";
import type {
  Attachment,
  Comment,
  ContextPack,
  ConfluencePage,
  Development,
  TicketLink,
  Warning,
  XrayTestCase,
} from "../../domain/contextPack/schema.js";
import type { NormalizedIssue } from "../../domain/tickets/normalizedIssue.js";
import { isXrayTestLink, issueToXrayTestCase, linkToXrayTestCase } from "../../domain/tickets/xray.js";
import type { TicketSource } from "./ticketSource.js";
import { uniqueBy } from "../../shared/utils.js";

export async function extractTicketContext(issueKey: string, source: TicketSource): Promise<ContextPack> {
  const warnings: Warning[] = [];
  const issue = await source.getIssue(issueKey);

  const comments = uniqueBy(
    [...issue.comments, ...(await optionalSection("comments", warnings, () => source.getComments(issueKey), []))],
    (comment) => comment.id ?? comment.url ?? `${comment.createdAt ?? ""}:${comment.body.slice(0, 80)}`,
  );

  const attachments = uniqueBy(
    await optionalSection<Attachment[]>("attachments", warnings, () => source.getAttachments(issueKey), []),
    (attachment) => attachment.id ?? attachment.url ?? attachment.filename,
  );

  const linkedIssues = uniqueBy(
    [
      ...issue.linkedIssues,
      ...(await optionalSection("linkedIssues", warnings, () => source.getLinkedIssues(issueKey), [])),
    ],
    (link) => link.issueKey ?? link.url,
  );

  const development = await optionalSection<Development>(
    "development",
    warnings,
    () => source.getDevelopmentLinks(issueKey),
    { branches: [], pullRequests: [] },
  );

  const confluencePages = uniqueBy(
    await optionalSection<ConfluencePage[]>("confluencePages", warnings, () => source.getConfluencePages(issueKey), []),
    (page) => page.url ?? page.id ?? page.title,
  );

  const xrayTestCases = uniqueBy(await fetchXrayTestCases(linkedIssues, source, warnings), (test) => test.key);

  const context: ContextPack = {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    ticket: {
      ...issue.ticket,
      links: linkedIssues,
    },
    description: issue.description,
    comments,
    attachments,
    xrayTestCases,
    development,
    confluencePages,
    provenance: {
      generatedAt: new Date().toISOString(),
      issueKey,
      source: source.getSourceName(),
      tools: source.getProvenance(),
    },
    warnings: [...warnings, ...source.getWarnings()],
  };

  return ContextPackSchema.parse(context);
}

async function fetchXrayTestCases(
  linkedIssues: TicketLink[],
  source: TicketSource,
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
      const testIssue: NormalizedIssue = await source.getIssue(link.issueKey);
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
