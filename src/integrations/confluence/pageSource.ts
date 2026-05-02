import type { ConfluencePage, ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import { firstPresent, firstString, isRecord, toIsoString, uniqueBy, unknownToText } from "../../shared/utils.js";
import type { ConfluencePageSource } from "../../workflows/confluence-impact/confluencePageSource.js";
import type { AtlassianRestClient } from "../atlassianRest/client.js";

export class ConfluenceRestPageSource implements ConfluencePageSource {
  private readonly client: AtlassianRestClient;
  private readonly provenance: ToolProvenance[] = [];
  private readonly warnings: Warning[] = [];

  constructor(client: AtlassianRestClient) {
    this.client = client;
  }

  async getPage(page: ConfluencePage): Promise<ConfluencePage> {
    const pageId = page.id ?? parseConfluencePageId(page.url);
    if (!pageId) {
      this.warnings.push({
        section: "confluencePages",
        toolName: "confluence-rest:content",
        message: `Could not resolve Confluence page id for ${page.url ?? page.title}.`,
      });
      return page;
    }

    const attempts = [
      {
        toolName: "confluence-rest:v1-content",
        path: `/rest/api/content/${encodeURIComponent(pageId)}`,
        query: { expand: "body.storage,body.view,version,space" },
      },
      {
        toolName: "confluence-rest:v2-pages",
        path: `/api/v2/pages/${encodeURIComponent(pageId)}`,
        query: { "body-format": "storage" },
      },
      {
        toolName: "confluence-rest:v1-content-root",
        path: `/wiki/rest/api/content/${encodeURIComponent(pageId)}`,
        query: { expand: "body.storage,body.view,version,space" },
      },
      {
        toolName: "confluence-rest:v2-pages-root",
        path: `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`,
        query: { "body-format": "storage" },
      },
    ];
    const failures: string[] = [];

    for (const attempt of attempts) {
      try {
        const raw = await this.callConfluence("getConfluencePage", attempt.toolName, () =>
          this.client.getJson("confluence", attempt.path, attempt.query),
        );
        return mergeConfluencePage(page, normalizeConfluencePage(raw, page.url));
      } catch (error) {
        failures.push(`${attempt.toolName}: ${errorMessage(error)}`);
      }
    }

    this.warnings.push({
      section: "confluencePages",
      toolName: "confluence-rest:content",
      message: `Could not hydrate Confluence page ${pageId}: ${failures.join(" | ").slice(0, 1500)}`,
    });

    return page;
  }

  getProvenance(): ToolProvenance[] {
    return [...this.provenance];
  }

  getWarnings(): Warning[] {
    return [...this.warnings];
  }

  private async callConfluence(method: string, toolName: string, action: () => Promise<unknown>): Promise<unknown> {
    const calledAt = new Date().toISOString();

    try {
      const result = await action();
      this.provenance.push({ method, toolName, calledAt, success: true });
      return result;
    } catch (error) {
      const message = errorMessage(error);
      this.provenance.push({ method, toolName, calledAt, success: false, message });
      throw error;
    }
  }
}

function normalizeConfluencePage(raw: unknown, fallbackUrl?: string): ConfluencePage {
  const title = firstString(raw, ["title", "name"]) ?? "Untitled Confluence page";
  const body = unknownToText(
    firstPresent(raw, [
      "body.storage.value",
      "body.view.value",
      "body.atlas_doc_format.value",
      "body.styled_view.value",
      "body",
    ]),
  );
  const id = firstString(raw, ["id"]);
  const url = buildConfluenceUrl(raw, fallbackUrl);
  const space = firstString(raw, ["space.key", "space.name", "spaceId"]);
  const updatedAt = toIsoString(firstPresent(raw, ["version.when", "version.createdAt", "version.createdDate", "updatedAt"]));

  return {
    title,
    ...(id ? { id } : {}),
    ...(space ? { space } : {}),
    ...(url ? { url } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(body ? { body } : {}),
  };
}

function buildConfluenceUrl(raw: unknown, fallbackUrl?: string): string | undefined {
  const base = firstString(raw, ["_links.base"]);
  const webui = firstString(raw, ["_links.webui"]);
  if (base && webui) {
    return `${base}${webui}`;
  }

  return firstString(raw, ["url", "_links.tinyui"]) ?? fallbackUrl;
}

function mergeConfluencePage(base: ConfluencePage, details: ConfluencePage): ConfluencePage {
  return {
    ...base,
    ...details,
    title: details.title || base.title,
  };
}

function parseConfluencePageId(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  return uniqueBy(
    [
      /[?&]pageId=(\d+)/.exec(url)?.[1],
      /\/pages\/(\d+)/.exec(url)?.[1],
      /\/wiki\/spaces\/[^/]+\/pages\/(\d+)/.exec(url)?.[1],
    ].filter((value): value is string => Boolean(value)),
    (value) => value,
  )[0];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (isRecord(error)) {
    return firstString(error, ["message", "error", "detail"]) ?? JSON.stringify(error);
  }

  return String(error);
}
