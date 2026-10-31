import type { ContextProvider } from "../../context/providerRegistry.js";
import type { KnowledgeIndex } from "../../context/knowledgeIndex.js";
import type { ContextPack, RelatedTicket, RetrievalCitation, Warning } from "../../domain/contextPack/schema.js";
import { issueToRelatedTicket } from "../../domain/tickets/related.js";
import { isXrayTestLink } from "../../domain/tickets/xray.js";
import { isRecord } from "../../integrations/llm/json.js";
import type { LlmTextClient } from "../../integrations/llm/types.js";

/**
 * Tool-using Researcher (M10g).
 *
 * Instead of dumping the whole corpus into the design prompt, an LLM drives a
 * bounded retrieval loop over a small toolset, expressed as a strict JSON
 * action protocol over the text client (no provider-specific tool-calling).
 * Tools:
 *   - search_context(query, topK) — BM25 retrieval over the knowledge index.
 *   - expand_ticket(key)          — fetch a linked ticket's body (bounded).
 *   - finish()                    — stop.
 *
 * Produces the relevant citations and any newly expanded related tickets. Pure
 * with respect to the model: a scripted stub client makes the loop fully
 * testable offline.
 */

const DEFAULT_MAX_STEPS = 4;

export interface AgenticStep {
  tool: string;
  args: unknown;
  observation: string;
}

export interface AgenticRetrievalResult {
  retrievalCitations: RetrievalCitation[];
  addedRelatedTickets: RelatedTicket[];
  steps: AgenticStep[];
}

export interface RunAgenticRetrievalInput {
  context: ContextPack;
  index: KnowledgeIndex;
  provider: ContextProvider;
  llm: LlmTextClient;
  warnings: Warning[];
  maxSteps?: number;
}

const SYSTEM_PROMPT = [
  "You are a test-design researcher gathering the most relevant evidence for a ticket.",
  "Each turn, respond with EXACTLY ONE JSON object — no prose, no markdown fences — choosing a tool:",
  '{ "tool": "search_context", "args": { "query": "<keywords>", "topK": 5 } }',
  '{ "tool": "expand_ticket", "args": { "key": "<linked ticket key>" } }',
  '{ "tool": "finish", "args": {} }',
  "Use search_context to find evidence for the acceptance criteria. Use expand_ticket only for keys",
  "listed as available. Call finish once you have gathered enough evidence. Keep queries focused.",
].join("\n");

export async function runAgenticRetrieval(input: RunAgenticRetrievalInput): Promise<AgenticRetrievalResult> {
  const { context, index, provider, llm, warnings } = input;
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;

  const citations: RetrievalCitation[] = [];
  const citationKeys = new Set<string>();
  const addedRelatedTickets: RelatedTicket[] = [];
  const steps: AgenticStep[] = [];

  const alreadyRelated = new Set((context.relatedTickets ?? []).map((related) => related.key));
  const availableKeys = context.ticket.links
    .filter((link) => Boolean(link.issueKey) && !isXrayTestLink(link) && !alreadyRelated.has(link.issueKey!))
    .map((link) => link.issueKey!);

  const addCitation = (citation: RetrievalCitation): void => {
    const key = `${citation.source}|${citation.reference}`;
    if (!citationKeys.has(key)) {
      citationKeys.add(key);
      citations.push(citation);
    }
  };

  let finished = false;
  for (let step = 0; step < maxSteps && !finished; step += 1) {
    const userPrompt = buildUserPrompt(context, availableKeys, steps);

    let raw: string;
    try {
      raw = await llm.generateText({ operation: "agentic-research", systemPrompt: SYSTEM_PROMPT, userPrompt });
    } catch (error) {
      warnings.push({ section: "agenticResearch", message: `Agentic research step failed: ${errorMessage(error)}` });
      break;
    }

    const action = parseAction(raw);
    if (!action) {
      steps.push({ tool: "unknown", args: raw, observation: "Could not parse a JSON action; please respond with one tool object." });
      continue;
    }

    if (action.tool === "finish") {
      steps.push({ tool: "finish", args: action.args, observation: "Research finished." });
      finished = true;
      break;
    }

    if (action.tool === "search_context") {
      const query = isRecord(action.args) && typeof action.args.query === "string" ? action.args.query : "";
      const topK = isRecord(action.args) && typeof action.args.topK === "number" ? action.args.topK : 5;
      const hits = query ? index.searchCitations(query, topK) : [];
      hits.forEach(addCitation);
      steps.push({
        tool: "search_context",
        args: action.args,
        observation: hits.length > 0 ? hits.map((c) => `- ${c.reference}: ${c.excerpt ?? ""}`).join("\n") : "No matching evidence.",
      });
      continue;
    }

    if (action.tool === "expand_ticket") {
      const key = isRecord(action.args) && typeof action.args.key === "string" ? action.args.key : "";
      if (!key || !availableKeys.includes(key)) {
        steps.push({ tool: "expand_ticket", args: action.args, observation: `"${key}" is not an available linked ticket.` });
        continue;
      }
      try {
        const issue = await provider.getIssue(key);
        const link = context.ticket.links.find((candidate) => candidate.issueKey === key);
        const related = issueToRelatedTicket(issue, link?.relationship);
        addedRelatedTickets.push(related);
        const indexPos = availableKeys.indexOf(key);
        if (indexPos >= 0) availableKeys.splice(indexPos, 1);
        steps.push({ tool: "expand_ticket", args: action.args, observation: `Expanded ${key}: ${related.title}` });
      } catch (error) {
        steps.push({ tool: "expand_ticket", args: action.args, observation: `Could not fetch ${key}: ${errorMessage(error)}` });
        warnings.push({ section: "agenticResearch", message: `Could not expand ${key}: ${errorMessage(error)}` });
      }
      continue;
    }

    steps.push({ tool: action.tool, args: action.args, observation: `Unknown tool "${action.tool}".` });
  }

  if (!finished && steps.length >= maxSteps) {
    warnings.push({ section: "agenticResearch", message: `Agentic research stopped at the ${maxSteps}-step budget.` });
  }

  return { retrievalCitations: citations, addedRelatedTickets, steps };
}

interface ParsedAction {
  tool: string;
  args: unknown;
}

function parseAction(raw: string): ParsedAction | undefined {
  const json = extractJsonObject(raw);
  if (!json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.tool !== "string") {
    return undefined;
  }
  return { tool: parsed.tool, args: parsed.args };
}

function extractJsonObject(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return trimmed.slice(start, end + 1);
}

function buildUserPrompt(context: ContextPack, availableKeys: string[], steps: AgenticStep[]): string {
  const lines: string[] = [];
  lines.push(`# Ticket ${context.ticket.key}: ${context.ticket.title}`);

  const acs = context.acceptanceCriteria ?? [];
  if (acs.length > 0) {
    lines.push("", "## Acceptance criteria to find evidence for");
    for (const ac of acs) lines.push(`- ${ac.id}: ${ac.text}`);
  }

  lines.push("", `## Available linked tickets to expand: ${availableKeys.length > 0 ? availableKeys.join(", ") : "(none)"}`);

  if (steps.length > 0) {
    lines.push("", "## Steps so far");
    for (const [i, step] of steps.entries()) {
      lines.push(`### Step ${i + 1}: ${step.tool}`, step.observation);
    }
  }

  lines.push("", "Respond with one JSON tool action now.");
  return lines.join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
