import type { AcceptanceCriterion, ContextPack } from "../../domain/contextPack/schema.js";
import type { DerivedRequirement } from "../../domain/testDesignPack/schema.js";
import { formatStepLibraryForPrompt, type StepLibrary } from "../../context/stepLibrary.js";
import type { RepoGuidanceFile } from "../../context/repoGuidance.js";
import { supplementalCabinContext } from "../../memory/cabin.js";

const DESCRIPTION_MAX = 6000;
// Comments often carry the richest spec on a ticket — a QA scenario table, dev
// clarifications, edge-case notes. The old 800-char cap clipped these (e.g. a
// 18-row scenario table rendered as markdown). Allow a generous per-comment cap
// and bound the worst case (many long comments) with a total budget.
const COMMENT_MAX = 8000;
const MAX_COMMENTS = 20;
const COMMENTS_TOTAL_BUDGET = 24000;
const CONFLUENCE_BODY_MAX = 800;
const MAX_CONFLUENCE = 5;
const MAX_ATTACHMENTS = 10;
const ATTACHMENT_ANALYSIS_MAX = 1500;
const MAX_EXISTING_TEST_CASES = 400;
const MAX_RELATED_TICKETS = 12;
const RELATED_BODY_MAX = 1200;

function truncate(value: string | undefined, max: number): string {
  if (!value) return "";
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…[truncated]`;
}

function listLine(label: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed ? `${label}: ${trimmed}` : undefined;
}

function buildContextSummary(context: ContextPack): string {
  const lines: string[] = [];
  lines.push("# Ticket");
  for (const line of [
    listLine("Key", context.ticket.key),
    listLine("Title", context.ticket.title),
    listLine("Type", context.ticket.issueType),
    listLine("Status", context.ticket.status),
    listLine("Labels", context.ticket.labels.join(", ")),
    listLine("Components", context.ticket.components.join(", ")),
  ]) {
    if (line) lines.push(line);
  }
  lines.push("");
  lines.push("# Description");
  lines.push(truncate(context.description.text, DESCRIPTION_MAX) || "_(no description)_");
  lines.push("");

  if (context.comments.length > 0) {
    lines.push("# Comments");
    let spent = 0;
    let shown = 0;
    for (const comment of context.comments.slice(0, MAX_COMMENTS)) {
      if (spent >= COMMENTS_TOTAL_BUDGET) break;
      const who = comment.author?.name ?? "Unknown";
      const when = comment.createdAt ?? "?";
      // Per-comment cap, further bounded by the remaining total budget.
      const body = truncate(comment.body, Math.min(COMMENT_MAX, COMMENTS_TOTAL_BUDGET - spent));
      lines.push(`- ${who} (${when}): ${body}`);
      spent += body.length;
      shown += 1;
    }
    const omitted = context.comments.length - shown;
    if (omitted > 0) {
      lines.push(`_(${omitted} more comment(s) omitted to bound prompt size)_`);
    }
    lines.push("");
  }

  if (context.confluencePages.length > 0) {
    lines.push("# Confluence excerpts");
    for (const page of context.confluencePages.slice(0, MAX_CONFLUENCE)) {
      const body = truncate(page.body, CONFLUENCE_BODY_MAX);
      lines.push(`- ${page.title}${body ? `: ${body}` : ""}`);
    }
    lines.push("");
  }

  if (context.attachments.length > 0) {
    lines.push("# Attachments");
    for (const attachment of context.attachments.slice(0, MAX_ATTACHMENTS)) {
      lines.push(`- ${attachment.filename}${attachment.mimeType ? ` (${attachment.mimeType})` : ""}`);
      if (attachment.analysis) {
        const body = truncate(attachment.analysis, ATTACHMENT_ANALYSIS_MAX);
        if (body) {
          lines.push(`  ${body.split("\n").join("\n  ")}`);
        }
      }
    }
    lines.push("");
  }

  if (context.ticket.links.length > 0) {
    lines.push("# Linked issues");
    for (const link of context.ticket.links) {
      lines.push(
        `- ${link.issueKey ?? "?"}: ${link.title ?? "(no title)"}${link.issueType ? ` [${link.issueType}]` : ""}${link.relationship ? ` (${link.relationship})` : ""}`,
      );
    }
    lines.push("");
  }

  const relatedTickets = context.relatedTickets ?? [];
  if (relatedTickets.length > 0) {
    lines.push("# Related tickets (epic/parent, subtasks, and linked stories — for requirement context)");
    for (const related of relatedTickets.slice(0, MAX_RELATED_TICKETS)) {
      const header = `## ${related.key}: ${related.title}${related.issueType ? ` [${related.issueType}]` : ""}${related.relationship ? ` (${related.relationship})` : ""}`;
      lines.push(header);
      const body = truncate(related.description, RELATED_BODY_MAX);
      if (body) {
        lines.push(body);
      }
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}

export interface AcExtractionPromptInput {
  context: ContextPack;
  skillBody: string;
}

const AC_OUTPUT_CONTRACT = `
## Output contract

Return ONLY a JSON array — no Markdown fences, no prose. Each item:

\`\`\`
{
  "id": "AC-<n>",          // sequential, starting at AC-1
  "text": "<one sentence in business language>",
  "source": "<optional: description | comment:<id> | confluence:<title>>"
}
\`\`\`
`.trim();

export function buildAcExtractionPrompt(input: AcExtractionPromptInput): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: `${input.skillBody}\n\n${AC_OUTPUT_CONTRACT}`,
    userPrompt: `${buildContextSummary(input.context)}\n\nReturn the JSON array now.`,
  };
}

export interface GherkinDesignPromptInput {
  context: ContextPack;
  acceptanceCriteria: AcceptanceCriterion[];
  skillBody: string;
  /** Existing step vocabulary from the target repo, to encourage reuse. */
  stepLibrary?: StepLibrary;
  /** Derived requirements (M22) the author should ALSO cover, via `drIds`. */
  derivedRequirements?: DerivedRequirement[];
  /** Repo guidance incl. learned rules from `.agents/guidelines/` (M25). */
  guidance?: RepoGuidanceFile[];
}

const GHERKIN_OUTPUT_CONTRACT = `
## Output contract

Return ONLY a JSON object — no Markdown fences, no prose. Shape:

\`\`\`
{
  "strategySummary": "<2-4 sentence overview of the test strategy>",
  "coverageGaps": ["<honest list of behaviours you could not cover>"],
  "openQuestions": ["<questions you would ask the product team>"],
  "acsCoveredByExisting": ["<AC ids already fully covered by an existing repo scenario — no new scenario written>"],
  "scenarios": [
    {
      "title": "<scenario title, business language>",
      "feature": "<feature name this scenario belongs to>",
      "tags": ["@login"],
      "acIds": ["AC-1"],
      "drIds": [],
      "polarity": "positive" | "negative" | "boundary",
      "risk": "high" | "medium" | "low",
      "readiness": "ready" | "needs-clarification",
      "objective": "<one sentence: what does this verify?>",
      "preconditions": ["<bullet-form preconditions>"],
      "steps": [
        { "keyword": "Given" | "When" | "Then" | "And" | "But", "text": "<step text>" },
        { "keyword": "Then", "text": "the table shows the columns:",
          "dataTable": [["column name"], ["Actions"], ["Invoice ID"]] }
      ],
      "sourceEvidence": [
        { "source": "description", "reference": "para 2", "summary": "<why this evidence justifies the scenario>" }
      ],
      "openQuestions": [],
      "rationale": "<why this scenario was designed this way>"
    }
  ]
}
\`\`\`

## Field rules

- \`acIds\`, \`drIds\`, \`polarity\` and \`risk\` are STRUCTURED fields used for the
  coverage gates and prioritisation. They are NOT tags. Set \`acIds\`, \`polarity\`
  and \`risk\` on every scenario; set \`drIds\` when the scenario covers a derived
  requirement (else omit or use \`[]\`).
- \`polarity\` is \`"positive"\` (happy path), \`"negative"\` (error/rejection path),
  or \`"boundary"\` (edge & boundary values). Each **high-risk** AC or derived
  requirement MUST have at least one \`negative\` or \`boundary\` scenario — do not
  cover a high-risk behaviour with only happy-path scenarios.
- \`tags\` are short, lower-case, feature-area labels describing the capability
  under test — e.g. \`@login\`, \`@checkout\`, \`@instalments\`, \`@search\`. Use one
  (occasionally two) per scenario.
- Do NOT put AC ids (\`@AC-3\`), risk levels (\`@high\`/\`@medium\`/\`@low\`),
  polarity (\`@positive\`/\`@negative\`), the Jira key, or \`@smoke\` into \`tags\`.
  The Jira-key tag is added at the feature level automatically, and \`@smoke\` is
  derived automatically from \`risk: "high"\`. Anything you add of those kinds is
  ignored.

## Hard constraints

- Every AC id MUST be accounted for: either covered by at least one scenario's
  \`acIds\` array, OR listed in \`acsCoveredByExisting\` because an existing repo
  scenario already covers it. Do not write a duplicate of an existing scenario.
- Cover, where the requirement justifies them: the happy path, valid
  alternatives, negative / error paths, edge & boundary values, security, and
  data variations. Use a Scenario Outline (\`examples\`) when one behaviour
  spans multiple data sets — do not split trivial data variations into many
  near-identical scenarios.
- Steps use business language and the user's perspective. Describe WHAT, not
  HOW — never UI selectors, API paths, or framework details.
- When a step asserts or supplies a **list of values** (e.g. table columns,
  dropdown options, multiple rows), attach a Gherkin **\`dataTable\`** to that
  ONE step — an array of rows, each row an array of cells, with a header row
  first (e.g. \`[["column name"], ["Actions"], ["Invoice ID"]]\`). NEVER spread
  the list across separate \`And <value>\` steps — that is malformed Gherkin and
  forces one step definition per value.
- One scenario, one behaviour. Steps in Given → When → Then order.
- If you cannot cover an AC with a defensible scenario, add it to
  \`coverageGaps\` and \`openQuestions\` rather than inventing one.
`.trim();

/**
 * Combined "do not duplicate" list of test cases that already exist for this
 * work: scenarios in the target repo's feature files (from the step library)
 * AND Xray test issues linked to the ticket (from the ContextPack). The author
 * is told to mark an AC as `acsCoveredByExisting` rather than re-author one of
 * these. Existing linked Xray tests are also skipped at upload by the sink.
 */
function buildExistingTestCasesSection(context: ContextPack, stepLibrary: StepLibrary | undefined): string {
  const items: string[] = [];
  for (const scenario of stepLibrary?.scenarios ?? []) {
    const kind = scenario.outline ? "Scenario Outline" : "Scenario";
    items.push(`- [repo] ${kind}: ${scenario.title}${scenario.feature ? ` (Feature: ${scenario.feature})` : ""}`);
  }
  for (const test of context.xrayTestCases) {
    items.push(`- [xray ${test.key}] ${test.title}${test.status ? ` (${test.status})` : ""}`);
  }
  if (items.length === 0) {
    return "";
  }

  const capped = items.slice(0, MAX_EXISTING_TEST_CASES);
  const lines: string[] = [];
  lines.push(
    `# Existing test cases (${capped.length}) — repository feature files and Xray tests linked to the ticket`,
  );
  lines.push(
    "Do NOT author a new scenario that means the same thing as any of these. When an acceptance criterion is ALREADY fully covered by one of them, put that AC id in `acsCoveredByExisting` instead of writing a duplicate. (Linked Xray tests with a matching title are also skipped automatically at upload.)",
  );
  lines.push(...capped);
  return lines.join("\n");
}

/**
 * Shared user-prompt body for every design mode: ticket context, the ACs to
 * cover, the existing-test dedup list, and (for step-reuse modes) the step
 * library. `includeStepLibrary` is false for plain-English, where repo step
 * phrasings are not relevant.
 */
function buildDesignUserPrompt(input: GherkinDesignPromptInput, includeStepLibrary: boolean): string {
  const acLines = input.acceptanceCriteria
    .map((ac) => `- ${ac.id}: ${ac.text}${ac.source ? ` _(source: ${ac.source})_` : ""}`)
    .join("\n");
  const existingTestCasesSection = buildExistingTestCasesSection(input.context, input.stepLibrary);
  const stepLibrarySection = includeStepLibrary && input.stepLibrary ? formatStepLibraryForPrompt(input.stepLibrary) : "";

  const parts = [
    buildContextSummary(input.context),
    "",
    "# Acceptance Criteria to cover",
    acLines || "_(none — emit no scenarios and surface this in coverageGaps)_",
  ];
  const derived = input.derivedRequirements ?? [];
  if (derived.length > 0) {
    const drLines = derived
      .map((dr) => `- ${dr.id} [${dr.category}, ${dr.risk} risk]: ${dr.text}`)
      .join("\n");
    parts.push(
      "",
      "# Derived requirements to ALSO cover (inferred beyond the literal ACs)",
      "Cover each with at least one scenario and set its id in that scenario's `drIds`. For any **high-risk** AC or derived requirement, include at least one **negative** or **boundary** scenario (set `polarity` accordingly), not only a happy path.",
      drLines,
    );
  }
  if (existingTestCasesSection) parts.push("", existingTestCasesSection);
  if (stepLibrarySection) parts.push("", stepLibrarySection);
  const guidanceSection = buildGuidanceSection(input.guidance);
  if (guidanceSection) parts.push("", guidanceSection);
  parts.push("", "Return the JSON object now.");
  return parts.join("\n");
}

/**
 * Team conventions & learned rules (M25): `AGENTS.md`, the `.agents/` docs,
 * and `.agents/guidelines/*.md` — the rules the learning engine proposed and
 * humans merged. Follow them when authoring; they were bounded at load time.
 */
function buildGuidanceSection(guidance: RepoGuidanceFile[] | undefined): string {
  if (!guidance || guidance.length === 0) return "";
  const lines: string[] = [
    "# Team conventions & learned rules (follow these when designing)",
  ];
  for (const file of guidance) {
    const fence = file.path.endsWith(".json") ? "json" : "markdown";
    lines.push("", `### ${file.path}`, "", `\`\`\`${fence}`, file.content.trim(), "```");
  }
  return lines.join("\n");
}

export function buildGherkinDesignPrompt(input: GherkinDesignPromptInput): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: `${input.skillBody}\n\n${GHERKIN_OUTPUT_CONTRACT}`,
    userPrompt: buildDesignUserPrompt(input, true) + supplementalCabinContext(),
  };
}

const PLAIN_ENGLISH_OUTPUT_CONTRACT = `
## Output contract

Return ONLY a JSON object — no Markdown fences, no prose. Shape:

\`\`\`
{
  "strategySummary": "<2-4 sentence overview of the test strategy>",
  "coverageGaps": ["<behaviours you could not cover>"],
  "openQuestions": ["<questions you would ask the product team>"],
  "acsCoveredByExisting": ["<AC ids already fully covered by an existing test>"],
  "scenarios": [
    {
      "title": "<manual test-case title, business language>",
      "feature": "<capability this test belongs to>",
      "tags": ["@login"],
      "acIds": ["AC-1"],
      "drIds": [],
      "polarity": "positive" | "negative" | "boundary",
      "risk": "high" | "medium" | "low",
      "readiness": "ready" | "needs-clarification",
      "objective": "<one sentence: what does this verify?>",
      "preconditions": ["<bullet-form preconditions>"],
      "steps": [
        { "action": "<what the tester does>", "expectedResult": "<what they should observe>" }
      ],
      "sourceEvidence": [
        { "source": "description", "reference": "para 2", "summary": "<why this justifies the test>" }
      ],
      "openQuestions": [],
      "rationale": "<why this test was designed this way>"
    }
  ]
}
\`\`\`

## Field rules

- These are MANUAL test cases: each step is an \`action\` + its \`expectedResult\`,
  not Given/When/Then. Write them so a human tester can follow them exactly.
- \`tags\` are short, lower-case, feature-area labels (e.g. \`@login\`). Do NOT put
  AC ids, risk levels, polarity, the Jira key, or \`@smoke\` in \`tags\`.
- \`acIds\`, \`drIds\`, \`polarity\` and \`risk\` are STRUCTURED fields. Set \`acIds\`,
  \`polarity\` (\`positive\`/\`negative\`/\`boundary\`) and \`risk\` on every test; set
  \`drIds\` when it covers a derived requirement. Each **high-risk** AC or derived
  requirement MUST have at least one \`negative\` or \`boundary\` test.
- Every AC id MUST be accounted for via \`acIds\` or \`acsCoveredByExisting\`.
- Steps use business language and the user's perspective — describe WHAT, not the
  UI selectors or framework details.
`.trim();

export function buildPlainEnglishDesignPrompt(input: GherkinDesignPromptInput): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: `${input.skillBody}\n\n${PLAIN_ENGLISH_OUTPUT_CONTRACT}`,
    userPrompt: buildDesignUserPrompt(input, false) + supplementalCabinContext(),
  };
}

// ---------------------------------------------------------------------------
// M22 — derived-requirement extraction
// ---------------------------------------------------------------------------

const DERIVED_REQUIREMENTS_SYSTEM = `
You are a senior QA strategist. The acceptance criteria of a ticket are the
*stated* contract, but they are rarely the *whole* requirement. Your job is to
read the FULL context (description, comments, linked/related tickets,
attachments) and surface the behaviours a thorough tester would verify that the
acceptance criteria do NOT explicitly state.

Look especially for: error & failure paths, validation & rejection, boundary
and edge values, empty/missing/maximal data, permissions & security, state &
concurrency, and notable non-functional expectations implied by the context.

Be rigorous, not imaginative. Every item MUST be grounded in evidence from the
provided context — if you cannot point to evidence, do not invent it. Do NOT
restate the acceptance criteria. Prefer a small set of high-value items over a
long speculative list.
`.trim();

const DERIVED_REQUIREMENTS_OUTPUT_CONTRACT = `
## Output contract

Return ONLY a JSON array — no Markdown fences, no prose. Each item:

\`\`\`
{
  "id": "DR-<n>",                 // sequential, starting at DR-1
  "text": "<one sentence: the implied behaviour to verify>",
  "category": "error" | "boundary" | "security" | "data" | "state" | "performance" | "usability" | "other",
  "risk": "high" | "medium" | "low",
  "sourceEvidence": [
    { "source": "description", "reference": "para 2", "summary": "<why the context implies this>" }
  ]
}
\`\`\`

Return \`[]\` if the acceptance criteria already capture everything testable.
`.trim();

export function buildDerivedRequirementsPrompt(input: {
  context: ContextPack;
  acceptanceCriteria: AcceptanceCriterion[];
}): { systemPrompt: string; userPrompt: string } {
  const acLines = input.acceptanceCriteria
    .map((ac) => `- ${ac.id}: ${ac.text}`)
    .join("\n");
  const userPrompt = [
    buildContextSummary(input.context),
    "",
    "# Acceptance Criteria already stated (do NOT restate these)",
    acLines || "_(none stated)_",
    "",
    "Return the JSON array of derived requirements now.",
  ].join("\n");
  return {
    systemPrompt: `${DERIVED_REQUIREMENTS_SYSTEM}\n\n${DERIVED_REQUIREMENTS_OUTPUT_CONTRACT}`,
    userPrompt,
  };
}

// ---------------------------------------------------------------------------
// M22 — adversarial critique ("what did this design miss?")
// ---------------------------------------------------------------------------

const CRITIQUE_SYSTEM = `
You are an adversarial test reviewer. You are given the ticket context, the
acceptance criteria, any derived requirements, and the scenarios already
drafted by another agent. Find the **genuinely missing** coverage — behaviours
that a careful tester would expect but that NONE of the drafted scenarios cover.

Author ONLY the missing scenarios (same output shape as the drafted ones, in
the requested mode). Do NOT duplicate or reword an existing scenario. Every new
scenario must be grounded in evidence from the context. If nothing material is
missing, return an empty \`scenarios\` array. Use \`gaps\` for behaviours you
believe matter but cannot responsibly author (e.g. needs product clarification),
and \`openQuestions\` for questions you would ask the team.
`.trim();

const CRITIQUE_OUTPUT_CONTRACT = `
## Output contract

Return ONLY a JSON object — no Markdown fences, no prose:

\`\`\`
{
  "gaps": ["<missing behaviour you could not responsibly author>"],
  "openQuestions": ["<question for the product team>"],
  "scenarios": [ /* zero or more scenarios, SAME shape & field rules as the design contract above */ ]
}
\`\`\`
`.trim();

export interface CritiquePromptInput extends GherkinDesignPromptInput {
  /** Mode-specific scenario contract reused verbatim so shapes match. */
  scenarioContract: string;
  /** Compact list of titles already drafted, to forbid duplicates. */
  draftedTitles: string[];
}

export function buildCritiquePrompt(input: CritiquePromptInput): { systemPrompt: string; userPrompt: string } {
  const drafted = input.draftedTitles.length > 0
    ? input.draftedTitles.map((t) => `- ${t}`).join("\n")
    : "_(none drafted)_";
  const userPrompt = [
    buildDesignUserPrompt(input, false),
    "",
    "# Scenarios already drafted (do NOT duplicate these)",
    drafted,
    "",
    "Return the JSON object of MISSING scenarios + gaps + openQuestions now.",
  ].join("\n");
  return {
    systemPrompt: `${CRITIQUE_SYSTEM}\n\n${input.scenarioContract}\n\n${CRITIQUE_OUTPUT_CONTRACT}`,
    userPrompt,
  };
}

/** Mode-specific scenario contracts, re-exported for the critique pass. */
export const SCENARIO_CONTRACTS = {
  gherkin: GHERKIN_OUTPUT_CONTRACT,
  "plain-english": PLAIN_ENGLISH_OUTPUT_CONTRACT,
} as const;

