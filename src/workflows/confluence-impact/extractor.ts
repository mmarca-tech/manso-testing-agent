import type { ContextPack, ConfluencePage, Warning } from "../../domain/contextPack/schema.js";
import { CONFLUENCE_IMPACT_SCHEMA_VERSION, ConfluenceImpactPackSchema } from "../../domain/confluenceImpact/schema.js";
import type { ConfluenceImpact, ConfluenceImpactPack, ConfluenceImpactPage } from "../../domain/confluenceImpact/schema.js";
import { uniqueBy } from "../../shared/utils.js";
import type { ConfluencePageSource } from "./confluencePageSource.js";
import type { ConfluenceImpactSummarizer } from "./summarizer.js";

interface ExtractConfluenceImpactOptions {
  sourceContextPath: string;
  onProgress?: (message: string) => void;
}

export async function extractConfluenceImpact(
  context: ContextPack,
  pageSource: ConfluencePageSource,
  summarizer: ConfluenceImpactSummarizer,
  options: ExtractConfluenceImpactOptions,
): Promise<ConfluenceImpactPack> {
  const warnings: Warning[] = [];
  const pages = uniqueBy(context.confluencePages, (page) => page.url ?? page.id ?? page.title);
  const outputPages: ConfluenceImpactPage[] = [];

  options.onProgress?.(`Found ${pages.length} unique linked Confluence page(s).`);
  let index = 0;
  for (const page of pages) {
    index += 1;
    options.onProgress?.(`Hydrating Confluence page ${index}/${pages.length}: ${page.title}.`);
    const hydratedPage = await hydratePage(page, pageSource, warnings);
    options.onProgress?.(`Summarizing Confluence page ${index}/${pages.length}: ${hydratedPage.title}.`);
    const impact = await summarizePage(context, hydratedPage, summarizer, warnings);

    outputPages.push({
      page: hydratedPage,
      extraction: {
        contentSource: hydratedPage.body && hydratedPage.body !== page.body ? "confluence-rest" : "context",
        bodyAvailable: Boolean(hydratedPage.body?.trim()),
        bodyLength: hydratedPage.body?.length ?? 0,
      },
      impact,
    });
    options.onProgress?.(`Completed Confluence page ${index}/${pages.length}: ${hydratedPage.title}.`);
  }

  const pack: ConfluenceImpactPack = {
    schemaVersion: CONFLUENCE_IMPACT_SCHEMA_VERSION,
    ticket: {
      key: context.ticket.key,
      title: context.ticket.title,
      ...(context.ticket.url ? { url: context.ticket.url } : {}),
    },
    pages: outputPages,
    provenance: {
      generatedAt: new Date().toISOString(),
      sourceContextPath: options.sourceContextPath,
      llm: {
        provider: summarizer.provider,
        model: summarizer.model,
      },
      tools: [...pageSource.getProvenance(), ...summarizer.getProvenance()],
    },
    warnings: [...warnings, ...pageSource.getWarnings(), ...summarizer.getWarnings()],
  };

  return ConfluenceImpactPackSchema.parse(pack);
}

async function hydratePage(
  page: ConfluencePage,
  pageSource: ConfluencePageSource,
  warnings: Warning[],
): Promise<ConfluencePage> {
  try {
    return await pageSource.getPage(page);
  } catch (error) {
    warnings.push({
      section: "confluencePages",
      message: `Could not hydrate Confluence page ${page.url ?? page.id ?? page.title}: ${errorMessage(error)}`,
    });
    return page;
  }
}

async function summarizePage(
  context: ContextPack,
  page: ConfluencePage,
  summarizer: ConfluenceImpactSummarizer,
  warnings: Warning[],
): Promise<ConfluenceImpact> {
  try {
    return await summarizer.summarize({
      context: {
        ticket: context.ticket,
        description: context.description,
        xrayTestCases: context.xrayTestCases,
        development: context.development,
      },
      page,
    });
  } catch (error) {
    warnings.push({
      section: "llm",
      message: `Could not summarize Confluence page ${page.url ?? page.id ?? page.title}: ${errorMessage(error)}`,
    });

    return {
      summary: "LLM impact summary unavailable for this Confluence page.",
      ticketRelevance: "Unknown.",
      impactedAreas: [],
      decisionsOrConstraints: [],
      risks: [],
      testingNotes: [],
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
