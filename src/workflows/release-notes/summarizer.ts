import type { ToolProvenance, Warning } from "../../domain/contextPack/schema.js";
import type { ReleaseNotes, ReleaseNotesLinkedTicket } from "../../domain/releaseNotes/schema.js";
import type { ContextPack } from "../../domain/contextPack/schema.js";

export interface ReleaseNotesInput {
  releaseContext: ContextPack;
  linkedTickets: ReleaseNotesLinkedTicket[];
}

export interface ReleaseNotesSummarizer {
  readonly provider: string;
  readonly model: string;
  summarize(input: ReleaseNotesInput): Promise<ReleaseNotes>;
  getProvenance(): ToolProvenance[];
  getWarnings(): Warning[];
}
