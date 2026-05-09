import type { Comment, ToolProvenance, Warning } from "../../../domain/contextPack/schema.js";
import { ReleaseNotesSchema } from "../../../domain/releaseNotes/schema.js";
import type { ReleaseNotes } from "../../../domain/releaseNotes/schema.js";
import type { ReleaseNotesInput, ReleaseNotesSummarizer } from "../../../workflows/release-notes/summarizer.js";
import { juanaSystemPrompt } from "./juanaPersona.js";
import { parseJsonObject } from "../json.js";
import type { LlmTextClient } from "../types.js";

export interface LlmReleaseNotesSummarizerOptions {
  client: LlmTextClient;
}

export class LlmReleaseNotesSummarizer implements ReleaseNotesSummarizer {
  private readonly client: LlmTextClient;
  private readonly provenance: ToolProvenance[] = [];
  private readonly warnings: Warning[] = [];

  constructor(options: LlmReleaseNotesSummarizerOptions) {
    this.client = options.client;
  }

  get provider(): string {
    return this.client.provider;
  }

  get model(): string {
    return this.client.model;
  }

  async summarize(input: ReleaseNotesInput): Promise<ReleaseNotes> {
    const calledAt = new Date().toISOString();

    try {
      const text = await this.client.generateText({
        operation: "generateReleaseNotes",
        systemPrompt: juanaSystemPrompt(
          "Create stakeholder-facing release notes for a Jira release ticket. Use only the provided JSON. Return strict JSON with title, audience, summary, highlights, changeItems, deploymentNotes, testingNotes, knownRisks, and ticketSummaries. Use linked ticket, Confluence, and development metadata only to verify scope. Do not expose technical evidence, branch names, pull requests, repositories, Confluence page names, or implementation mechanics in the release-note text.",
        ),
        userPrompt: buildPrompt(input),
      });
      const parsed = parseJsonObject(text);
      this.provenance.push({ method: "generateReleaseNotes", toolName: this.client.toolName, calledAt, success: true });
      return ReleaseNotesSchema.parse(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.provenance.push({ method: "generateReleaseNotes", toolName: this.client.toolName, calledAt, success: false, message });
      throw error;
    }
  }

  getProvenance(): ToolProvenance[] {
    return [...this.provenance];
  }

  getWarnings(): Warning[] {
    return [...this.warnings];
  }
}

function buildPrompt(input: ReleaseNotesInput): string {
  const payload = {
    releaseTicket: {
      key: input.releaseContext.ticket.key,
      title: input.releaseContext.ticket.title,
      issueType: input.releaseContext.ticket.issueType,
      status: input.releaseContext.ticket.status,
      labels: input.releaseContext.ticket.labels,
      components: input.releaseContext.ticket.components,
      description: trimText(input.releaseContext.description.text, 5000),
      comments: input.releaseContext.comments.slice(-10).map(compactComment),
    },
    linkedTickets: input.linkedTickets.map(({ relationship, context }) => ({
      relationship,
      ticket: {
        key: context.ticket.key,
        title: context.ticket.title,
        issueType: context.ticket.issueType,
        status: context.ticket.status,
        labels: context.ticket.labels,
        components: context.ticket.components,
        url: context.ticket.url,
      },
      description: trimText(context.description.text, 7000),
      recentComments: context.comments.slice(-5).map(compactComment),
      confluencePages: context.confluencePages.slice(0, 12).map((page) => ({
        title: page.title,
        space: page.space,
        url: page.url,
        updatedAt: page.updatedAt,
        body: trimText(page.body ?? "", 7000),
      })),
      development: {
        branches: context.development.branches.slice(0, 20).map((branch) => ({
          name: branch.name,
          repository: branch.repository,
          provider: branch.provider,
          url: branch.url,
          lastUpdatedAt: branch.lastUpdatedAt,
        })),
        pullRequests: context.development.pullRequests.slice(0, 30).map((pullRequest) => ({
          title: pullRequest.title,
          status: pullRequest.status,
          repository: pullRequest.repository,
          provider: pullRequest.provider,
          sourceBranch: pullRequest.sourceBranch,
          targetBranch: pullRequest.targetBranch,
          author: pullRequest.author?.name ?? pullRequest.author?.email,
          lastUpdatedAt: pullRequest.lastUpdatedAt,
          url: pullRequest.url,
        })),
      },
      attachments: context.attachments.slice(0, 20).map((attachment) => ({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        url: attachment.url,
      })),
    })),
  };

  return `Generate release notes for the release ticket from this source JSON.

Required JSON shape:
{
  "title": "release-note title",
  "audience": "target readers",
  "summary": "short overview paragraph",
  "highlights": ["plain-language shipped highlight"],
  "changeItems": [
    {
      "area": "release area",
      "description": "what changed",
      "impact": "why it matters to users, operations, support, or QA",
      "tickets": ["ABC-123"]
    }
  ],
  "deploymentNotes": ["stakeholder-relevant rollout note"],
  "testingNotes": ["release validation note"],
  "knownRisks": ["known risk, dependency, or uncertainty"],
  "ticketSummaries": [
    {
      "key": "ABC-123",
      "title": "ticket title",
      "issueType": "Story",
      "status": "Done",
      "relationship": "relates to",
      "summary": "short ticket-specific release note",
      "userImpact": "optional user-facing impact",
      "risks": ["ticket-specific risk or ambiguity"],
      "testingNotes": ["ticket-specific verification note"]
    }
  ]
}

Rules:
- Include every linked Jira ticket in ticketSummaries exactly once.
- Keep release notes polished, concise, and readable by non-implementers.
- Prefer user-facing language for highlights and changeItems.
- Do not include technical details that readers can find by opening the linked Jira tickets.
- Do not mention branch names, pull request titles, repository names, module names, Confluence page titles, source coverage, or LLM/source evidence.
- Use development and Confluence metadata only as private evidence to avoid unsupported scope.
- Put only stakeholder-relevant missing details, ambiguous scope, or unresolved statuses in knownRisks or ticket-specific risks.
- Keep testing notes outcome-oriented; avoid implementation verification steps unless they are essential release checks.
- Return JSON only, without Markdown fences.

Input:
${JSON.stringify(payload, null, 2)}`;
}

function compactComment(comment: Comment): unknown {
  return {
    author: comment.author?.name ?? comment.author?.email,
    createdAt: comment.createdAt,
    body: trimText(comment.body, 1500),
  };
}

function trimText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}\n[... truncated ...]`;
}
