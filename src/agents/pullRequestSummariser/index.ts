import type { VcsPullRequestDiff } from "../../integrations/vcs/adapter.js";
import type { LlmTextClient } from "../../integrations/llm/types.js";
import { isRecord, parseJsonObject } from "../../integrations/llm/json.js";

export interface PullRequestUnderstanding {
  /** 1-3 sentences, plain English, no internal jargon. */
  summary: string;
  /** e.g. ["authentication", "database migrations"]. */
  changeAreas: string[];
  /** Empty array if none identified. */
  risks: string[];
}

export interface SummarisePullRequestInput {
  pullRequestTitle: string;
  ticketTitle: string;
  diff: VcsPullRequestDiff;
  llm: LlmTextClient;
}

const MAX_FILES = 15;
const MAX_PATCH_CHARS = 4000;

function buildSystemPrompt(): string {
  return `You are a senior engineer writing an internal PR summary for a release-notes pipeline.

You will receive a pull request's title, the ticket it is linked to, and its changed files
(with unified diff patches when available).

Your task:
- Summarise, in 1-3 sentences, what the PR actually changes (plain English, no internal jargon).
- List the functional/technical areas it touches (e.g. "authentication", "database migrations").
- List any risks you notice (empty array if none).

Respond with a JSON object (no markdown fences) matching this schema:
{
  "summary": "<1-3 sentences>",
  "changeAreas": ["<area>", "..."],
  "risks": ["<risk>", "..."]
}`;
}

function buildUserPrompt(input: SummarisePullRequestInput): string {
  const parts: string[] = [];
  parts.push(`# Pull Request: ${input.pullRequestTitle}`);
  parts.push(`Ticket: ${input.ticketTitle}`);

  const { files, hasPatches } = input.diff;
  const included = files.slice(0, MAX_FILES);
  const omitted = files.length - included.length;

  const includedHasAnyPatch = included.some((file) => Boolean(file.patch));

  if (includedHasAnyPatch) {
    parts.push(`\n## Changed Files${hasPatches ? " (with patches)" : " (partial patches)"}`);
    for (const file of included) {
      if (file.patch) {
        const truncated = file.patch.length > MAX_PATCH_CHARS ? `${file.patch.slice(0, MAX_PATCH_CHARS)}…[truncated]` : file.patch;
        parts.push(`\n### ${file.path} (${file.changeType})\n\`\`\`diff\n${truncated}\n\`\`\``);
      } else {
        parts.push(`- ${file.path} (${file.changeType}; patch unavailable)`);
      }
    }
  } else {
    parts.push(`\n## Changed Files`);
    for (const file of included) {
      parts.push(`- ${file.path} (${file.changeType})`);
    }
  }

  if (omitted > 0) {
    parts.push(`\n(${omitted} additional file(s) omitted for brevity)`);
  }

  return parts.join("\n");
}

/**
 * Summarise one pull request's diff into a short natural-language
 * understanding, via LLM. Errors are not swallowed here — the caller decides
 * whether a failed PR summary is fatal or just a skipped PR.
 */
export async function summarisePullRequest(input: SummarisePullRequestInput): Promise<PullRequestUnderstanding> {
  const raw = await input.llm.generateText({
    systemPrompt: buildSystemPrompt(),
    userPrompt: buildUserPrompt(input),
    operation: "release-notes-pr-summary",
  });

  const parsed = parseJsonObject(raw);
  if (!isRecord(parsed)) {
    throw new Error("PR summary response is not a JSON object");
  }
  if (typeof parsed.summary !== "string" || parsed.summary.trim().length === 0) {
    throw new Error("PR summary response is missing a non-empty 'summary'");
  }

  const changeAreas = Array.isArray(parsed.changeAreas)
    ? parsed.changeAreas.filter((x): x is string => typeof x === "string")
    : [];
  const risks = Array.isArray(parsed.risks) ? parsed.risks.filter((x): x is string => typeof x === "string") : [];

  return { summary: parsed.summary, changeAreas, risks };
}
