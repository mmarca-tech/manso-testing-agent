import type { ContextPack, Warning } from "../../domain/contextPack/schema.js";
import type { LinkedCucumberTest } from "../../integrations/xray/testFetch.js";
import type { LlmTextClient } from "../../integrations/llm/types.js";
import { isRecord, parseJsonObject } from "../../integrations/llm/json.js";
import { supplementalCabinContext } from "../../memory/cabin.js";
import {
  GherkinScenarioSchema,
  type TestScenario,
} from "../../domain/testDesignPack/schema.js";

export interface CoverageGapAnalysis {
  /** Summary of the assessment. */
  summary: string;
  /** Acceptance criteria that are not covered by any test case. */
  uncoveredCriteria: UncoveredCriterion[];
  /** Functional areas with insufficient test coverage. */
  gaps: CoverageGap[];
  /** Overall coverage assessment: good, partial, or poor. */
  rating: "good" | "partial" | "poor";
}

export interface UncoveredCriterion {
  /** The acceptance criterion text. */
  criterion: string;
  /** Why it matters. */
  impact: string;
}

export interface CoverageGap {
  /** Area or behaviour that is undertested. */
  area: string;
  /** What is missing (edge cases, negative scenarios, etc.). */
  description: string;
  /** Priority: high, medium, low. */
  priority: "high" | "medium" | "low";
}

export interface CoverageGapAnalyserInput {
  context: ContextPack;
  /** All linked Cucumber tests with their Gherkin bodies. */
  linkedTests: LinkedCucumberTest[];
  llm: LlmTextClient;
  /** Optional gherkin-authoring skill body, injected so new scenarios follow house conventions. */
  bindingSkillBody?: string;
  /** Optional existing step phrasings from the target repo, so new scenarios reuse them. */
  existingSteps?: string[];
}

export interface CoverageGapAnalyserOutput {
  analysis: CoverageGapAnalysis;
  /** Scenarios designed to fill the identified gaps (schema-validated). */
  newScenarios: TestScenario[];
  warnings: Warning[];
}

const RATINGS = ["good", "partial", "poor"] as const;
const PRIORITIES = ["high", "medium", "low"] as const;

/**
 * Build the system prompt for the coverage gap analysis LLM call.
 * The LLM acts as a senior QA engineer analysing test coverage.
 */
function buildAnalysisSystemPrompt(): string {
  return `You are a senior QA engineer performing a test coverage analysis.

You will receive:
1. A user story with its description, acceptance criteria, and comments
2. The existing test cases (Cucumber/Gherkin) that are currently linked to this user story

Your task:
- Analyse whether the existing test cases adequately cover all acceptance criteria and functional requirements in the user story
- Identify coverage gaps: missing scenarios, untested edge cases, missing negative/boundary tests, untested error handling
- Assess the overall coverage quality

Respond with a JSON object (no markdown fences) matching this schema:
{
  "summary": "<2-3 sentence assessment of overall test coverage>",
  "rating": "good" | "partial" | "poor",
  "uncoveredCriteria": [
    { "criterion": "<the AC or requirement text>", "impact": "<why this gap matters>" }
  ],
  "gaps": [
    { "area": "<functional area>", "description": "<what is missing>", "priority": "high" | "medium" | "low" }
  ]
}

Be thorough but precise. Only report genuine gaps — do not invent problems where coverage is adequate.
If the tests fully cover the story, return rating "good" with empty arrays.`;
}

/**
 * Build the user prompt with all the context for analysis.
 */
function buildAnalysisUserPrompt(input: CoverageGapAnalyserInput): string {
  const { context, linkedTests } = input;
  const parts: string[] = [];

  parts.push(`# User Story: ${context.ticket.key} — ${context.ticket.title}`);
  parts.push(`\n## Description\n${context.description.text}`);

  if (context.comments.length > 0) {
    parts.push(`\n## Comments`);
    for (const comment of context.comments) {
      const author = comment.author?.name ?? "Unknown";
      parts.push(`\n### ${author} (${comment.createdAt ?? "no date"})\n${comment.body}`);
    }
  }

  if (context.acceptanceCriteria && context.acceptanceCriteria.length > 0) {
    parts.push(`\n## Acceptance Criteria`);
    for (const ac of context.acceptanceCriteria) {
      parts.push(`- [${ac.id}] ${ac.text}`);
    }
  }

  if (linkedTests.length > 0) {
    parts.push(`\n## Existing Test Cases (${linkedTests.length} linked Cucumber tests)`);
    for (const test of linkedTests) {
      parts.push(`\n### ${test.key}: ${test.summary}\n\`\`\`gherkin\n${test.gherkin}\n\`\`\``);
    }
  } else {
    parts.push(`\n## Existing Test Cases\nNone — no Cucumber tests are linked to this story.`);
  }

  return parts.join("\n");
}

/**
 * Parse the LLM's JSON response into a structured CoverageGapAnalysis.
 * Tolerant of minor formatting issues.
 */
function parseAnalysisResponse(raw: string): CoverageGapAnalysis {
  const parsed = parseJsonObject(raw);
  if (!isRecord(parsed)) {
    throw new Error("analysis response is not a JSON object");
  }

  const rating = RATINGS.includes(parsed.rating as (typeof RATINGS)[number])
    ? (parsed.rating as CoverageGapAnalysis["rating"])
    : "partial";
  const uncoveredCriteria = Array.isArray(parsed.uncoveredCriteria)
    ? parsed.uncoveredCriteria.filter(isRecord).map((item) => ({
        criterion: String(item.criterion ?? ""),
        impact: String(item.impact ?? ""),
      }))
    : [];
  const gaps = Array.isArray(parsed.gaps)
    ? parsed.gaps.filter(isRecord).map((item) => ({
        area: String(item.area ?? ""),
        description: String(item.description ?? ""),
        priority: PRIORITIES.includes(String(item.priority) as (typeof PRIORITIES)[number])
          ? (item.priority as CoverageGap["priority"])
          : "medium",
      }))
    : [];

  return { summary: String(parsed.summary ?? ""), rating, uncoveredCriteria, gaps };
}

/**
 * Build the system prompt for the scenario generation pass.
 */
function buildScenarioGenSystemPrompt(bindingSkillBody?: string): string {
  const base = `You are a senior QA engineer writing Gherkin (Cucumber) test scenarios to fill identified coverage gaps.

You will receive the coverage gap analysis and the story context. Write new Gherkin scenarios that fill those gaps.

Respond with a JSON object (no markdown fences):
{
  "scenarios": [
    {
      "kind": "gherkin",
      "title": "<scenario title in business language>",
      "feature": "<feature name>",
      "tags": ["@tag1"],
      "acIds": [],
      "risk": "high" | "medium" | "low",
      "readiness": "ready",
      "objective": "<what this verifies>",
      "preconditions": ["<precondition>"],
      "steps": [
        { "keyword": "Given", "text": "<step text>" },
        { "keyword": "When", "text": "<step text>" },
        { "keyword": "Then", "text": "<step text>" }
      ],
      "sourceEvidence": [{ "source": "coverage-gap-analysis", "reference": "<gap area>", "summary": "<why needed>" }],
      "openQuestions": [],
      "rationale": "<why this scenario fills a gap>"
    }
  ]
}

Every scenario must have a non-empty title and at least one Given, one When, and one Then step with non-empty text.
Focus on the highest-priority gaps first. Do not duplicate existing test scenarios.

CRITICAL — reuse existing step phrasings: you will be given the step lines already
used by the linked tests (and repo). When a step you need matches one of those in
meaning, reuse that EXACT wording (verbatim) instead of inventing a differently-worded
step. This avoids creating duplicate Cucumber step definitions for the same behaviour.`;

  if (bindingSkillBody && bindingSkillBody.trim().length > 0) {
    return `${base}\n\n## Authoring conventions (follow these)\n${bindingSkillBody.trim()}`;
  }
  return base;
}

const STEP_LINE_RE = /^\s*(Given|When|Then|And|But)\s+(.+\S)\s*$/;

/** Extract step lines (e.g. "Given a user is logged in") from a Gherkin body. */
function extractStepsFromGherkin(gherkin: string): string[] {
  const out: string[] = [];
  for (const raw of gherkin.split(/\r?\n/)) {
    const m = STEP_LINE_RE.exec(raw.trim());
    if (m) out.push(`${m[1]} ${m[2]}`);
  }
  return out;
}

/**
 * The step vocabulary the generator should reuse: the steps already written in
 * the linked Cucumber tests (always available) plus any repo step phrasings
 * (from `--repo`). Deduped (case/space-insensitive) and capped.
 */
function collectExistingSteps(input: CoverageGapAnalyserInput): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (line: string): void => {
    const key = line.toLowerCase().replace(/\s+/g, " ").trim();
    if (key.length > 0 && !seen.has(key)) {
      seen.add(key);
      out.push(line);
    }
  };
  for (const test of input.linkedTests) {
    for (const step of extractStepsFromGherkin(test.gherkin)) add(step);
  }
  for (const step of input.existingSteps ?? []) add(step);
  return out.slice(0, 150);
}

/**
 * Build the user prompt for scenario generation.
 */
function buildScenarioGenUserPrompt(
  input: CoverageGapAnalyserInput,
  analysis: CoverageGapAnalysis,
  existingSteps: string[],
): string {
  const { context, linkedTests } = input;
  const parts: string[] = [];

  parts.push(`# Coverage Gap Analysis Results`);
  parts.push(`\nRating: ${analysis.rating}`);
  parts.push(`Summary: ${analysis.summary}`);

  if (analysis.uncoveredCriteria.length > 0) {
    parts.push(`\n## Uncovered Criteria`);
    for (const uc of analysis.uncoveredCriteria) {
      parts.push(`- ${uc.criterion} (Impact: ${uc.impact})`);
    }
  }

  if (analysis.gaps.length > 0) {
    parts.push(`\n## Coverage Gaps`);
    for (const gap of analysis.gaps) {
      parts.push(`- [${gap.priority}] ${gap.area}: ${gap.description}`);
    }
  }

  parts.push(`\n# Story Context`);
  parts.push(`## ${context.ticket.key} — ${context.ticket.title}`);
  parts.push(`\n${context.description.text}`);

  if (context.acceptanceCriteria && context.acceptanceCriteria.length > 0) {
    parts.push(`\n## Acceptance Criteria`);
    for (const ac of context.acceptanceCriteria) {
      parts.push(`- [${ac.id}] ${ac.text}`);
    }
  }

  if (existingSteps.length > 0) {
    parts.push(`\n## Existing step phrasings — REUSE these verbatim where they fit (do not reword them)`);
    for (const step of existingSteps) {
      parts.push(`- ${step}`);
    }
  }

  if (linkedTests.length > 0) {
    parts.push(`\n## Existing Tests (do NOT duplicate these scenarios)`);
    for (const test of linkedTests) {
      parts.push(`- ${test.key}: ${test.summary}`);
    }
  }

  return parts.join("\n");
}

/**
 * Parse the scenario generation response into raw scenario objects. The result
 * is validated against the schema by the caller (invalid scenarios are dropped).
 */
function parseScenarioGenResponse(raw: string): unknown[] {
  const parsed = parseJsonObject(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.scenarios)) {
    return [];
  }
  return parsed.scenarios.map((s) => {
    if (!isRecord(s)) return s;
    return {
      kind: "gherkin",
      title: String(s.title ?? ""),
      feature: String(s.feature ?? "Coverage Gap Tests"),
      tags: Array.isArray(s.tags) ? s.tags.map(String) : [],
      acIds: Array.isArray(s.acIds) ? s.acIds.map(String) : [],
      risk: PRIORITIES.includes(String(s.risk) as (typeof PRIORITIES)[number]) ? s.risk : "medium",
      readiness: "ready",
      objective: String(s.objective ?? ""),
      preconditions: Array.isArray(s.preconditions) ? s.preconditions.map(String) : [],
      steps: Array.isArray(s.steps)
        ? s.steps.filter(isRecord).map((step) => ({
            keyword: String(step.keyword ?? "Given"),
            text: String(step.text ?? ""),
          }))
        : [],
      sourceEvidence: Array.isArray(s.sourceEvidence)
        ? s.sourceEvidence.filter(isRecord).map((e) => ({
            source: String(e.source ?? "coverage-gap-analysis"),
            reference: String(e.reference ?? ""),
            summary: String(e.summary ?? ""),
          }))
        : [{ source: "coverage-gap-analysis", reference: "gap", summary: "Fills identified coverage gap" }],
      openQuestions: Array.isArray(s.openQuestions) ? s.openQuestions.map(String) : [],
      rationale: String(s.rationale ?? ""),
    };
  });
}

/**
 * Run the Coverage Gap Analyser: assess existing test coverage for a user
 * story and identify gaps, then generate new test scenarios to fill them.
 *
 * Two-pass LLM flow:
 *   Pass 1 — Analyse coverage against the story context + existing tests.
 *   Pass 2 — Generate new Gherkin scenarios for identified gaps (only if gaps exist).
 *
 * Generated scenarios are validated against {@link GherkinScenarioSchema};
 * malformed ones are dropped (with a warning) so a bad LLM payload can never
 * crash the downstream Xray upload.
 */
export async function runCoverageGapAnalyser(input: CoverageGapAnalyserInput): Promise<CoverageGapAnalyserOutput> {
  const warnings: Warning[] = [];

  // Pass 1: Analyse coverage gaps
  const analysisResponse = await input.llm.generateText({
    systemPrompt: buildAnalysisSystemPrompt(),
    userPrompt: buildAnalysisUserPrompt(input) + supplementalCabinContext(),
    operation: "coverage-gap-analysis",
  });

  let analysis: CoverageGapAnalysis;
  try {
    analysis = parseAnalysisResponse(analysisResponse);
  } catch (error) {
    warnings.push({
      section: "coverageGapAnalysis",
      toolName: "llm:analysis",
      message: `Failed to parse coverage analysis response: ${error instanceof Error ? error.message : String(error)}`,
    });
    analysis = {
      summary: "Could not parse the LLM analysis response.",
      rating: "partial",
      uncoveredCriteria: [],
      gaps: [],
    };
  }

  // Pass 2: Generate scenarios only if there are gaps
  let newScenarios: TestScenario[] = [];
  if (analysis.rating !== "good" && (analysis.gaps.length > 0 || analysis.uncoveredCriteria.length > 0)) {
    const existingSteps = collectExistingSteps(input);
    const scenarioResponse = await input.llm.generateText({
      systemPrompt: buildScenarioGenSystemPrompt(input.bindingSkillBody),
      userPrompt: buildScenarioGenUserPrompt(input, analysis, existingSteps) + supplementalCabinContext(),
      operation: "coverage-gap-scenario-gen",
    });

    try {
      const raw = parseScenarioGenResponse(scenarioResponse);
      // Validate each scenario against the schema; drop (and warn about) invalid ones
      // so a malformed payload can never reach (and crash) the Xray upload.
      for (const candidate of raw) {
        const result = GherkinScenarioSchema.safeParse(candidate);
        if (result.success) {
          newScenarios.push(result.data);
        } else {
          const title = isRecord(candidate) ? String(candidate.title ?? "(untitled)") : "(untitled)";
          warnings.push({
            section: "coverageGapAnalysis",
            toolName: "llm:scenario-gen",
            message: `Dropped an invalid generated scenario "${title}": ${result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
          });
        }
      }
    } catch (error) {
      warnings.push({
        section: "coverageGapAnalysis",
        toolName: "llm:scenario-gen",
        message: `Failed to parse scenario generation response: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return { analysis, newScenarios, warnings };
}

// ---------------------------------------------------------------------------
// Jira comment rendering (Atlassian Document Format)
// ---------------------------------------------------------------------------

type AdfNode = { type: string; [key: string]: unknown };
export interface AdfDocument {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

function text(value: string, marks?: string[]): AdfNode {
  return marks && marks.length > 0
    ? { type: "text", text: value, marks: marks.map((m) => ({ type: m })) }
    : { type: "text", text: value };
}
function paragraph(...inline: AdfNode[]): AdfNode {
  return { type: "paragraph", content: inline };
}
function heading(level: number, value: string): AdfNode {
  return { type: "heading", attrs: { level }, content: [text(value)] };
}
function bulletList(items: AdfNode[][]): AdfNode {
  return {
    type: "bulletList",
    content: items.map((blocks) => ({ type: "listItem", content: blocks })),
  };
}

/**
 * Format the coverage gap analysis as a Jira comment in **Atlassian Document
 * Format** (ADF) — the shape the v3 `/comment` endpoint requires. (Earlier this
 * produced wiki markup, which rendered as raw text inside an ADF text node.)
 */
export function formatAnalysisAsComment(analysis: CoverageGapAnalysis, newScenarios: TestScenario[]): AdfDocument {
  const content: AdfNode[] = [];

  content.push(heading(2, "Manso Coverage Gap Analysis"));
  content.push(paragraph(text("Overall rating: "), text(analysis.rating.toUpperCase(), ["strong"])));
  if (analysis.summary) {
    content.push(paragraph(text(analysis.summary)));
  }

  if (analysis.uncoveredCriteria.length > 0) {
    content.push(heading(3, "Uncovered Acceptance Criteria"));
    content.push(
      bulletList(
        analysis.uncoveredCriteria.map((uc) => [
          paragraph(text(uc.criterion, ["strong"]), text(` — Impact: ${uc.impact}`)),
        ]),
      ),
    );
  }

  if (analysis.gaps.length > 0) {
    content.push(heading(3, "Coverage Gaps"));
    content.push(
      bulletList(
        analysis.gaps.map((gap) => [
          paragraph(text(`[${gap.priority.toUpperCase()}] ${gap.area}`, ["strong"]), text(`: ${gap.description}`)),
        ]),
      ),
    );
  }

  if (newScenarios.length > 0) {
    content.push(heading(3, `Recommended Test Cases (${newScenarios.length})`));
    content.push(paragraph(text("The following test cases were created to address the coverage gaps:")));
    content.push(
      bulletList(
        newScenarios.map((scenario) => [
          paragraph(text(scenario.title, ["strong"]), text(` — ${scenario.objective}`)),
        ]),
      ),
    );
  }

  if (analysis.rating === "good") {
    content.push({
      type: "panel",
      attrs: { panelType: "success" },
      content: [paragraph(text("Test coverage is adequate. No gaps identified."))],
    });
  }

  content.push({ type: "rule" });
  content.push(paragraph(text("Generated by Manso coverage gap analysis", ["em"])));

  return { type: "doc", version: 1, content };
}
