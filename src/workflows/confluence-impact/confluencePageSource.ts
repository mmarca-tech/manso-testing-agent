import type { ConfluencePage, ToolProvenance, Warning } from "../../domain/contextPack/schema.js";

export interface ConfluencePageSource {
  getPage(page: ConfluencePage): Promise<ConfluencePage>;
  getProvenance(): ToolProvenance[];
  getWarnings(): Warning[];
}
