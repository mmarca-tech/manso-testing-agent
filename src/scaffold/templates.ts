import type { DetectedStack } from "./stackDetection.js";

/** A file the scaffolder writes into a target repository. */
export interface TemplateFile {
  /** Path relative to the repo root, POSIX-separated. */
  path: string;
  content: string;
}

export interface TemplateInput {
  /** Human-readable product name, pre-filled into the config. */
  productName: string;
  /** Stacks detected in the repo, pre-filled into the config. */
  detectedStacks: DetectedStack[];
}

/** Build the `.agents/manso.config.json` object for a repository. */
function buildAgentConfig(input: TemplateInput): unknown {
  return {
    schemaVersion: "1.0.0",
    product: input.productName,
    testDesign: { outputMode: "gherkin", language: "en" },
    stacks: input.detectedStacks.map((stack) => {
      const entry: Record<string, unknown> = {
        id: stack.id,
        root: stack.root,
        verifyCommand: stack.verifyCommand,
      };
      if (stack.featureGlob) {
        entry.featureGlob = stack.featureGlob;
      }
      return entry;
    }),
    context: {
      providers: ["jira-rest", "confluence-rest", "xray", "azure-devops"],
      rovoMcp: { enabled: false },
      linkedTicketDepth: 1,
      attachmentUnderstanding: true,
    },
    // MCP servers exposed to the implementation agent. stdio servers launch as
    // subprocesses; http/sse servers connect remotely. Header/env values may use
    // ${ENV_VAR} placeholders, expanded at run time so no secret lives in this
    // file. To add Figma, for example:
    //   "figma": { "type": "http", "url": "https://mcp.figma.com",
    //              "headers": { "Authorization": "Bearer ${FIGMA_MCP_TOKEN}" } }
    mcpServers: {
      playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
    },
    xray: { createCucumberTests: true, createTestExecutions: true },
    policy: {
      gates: {
        acCoverage: "required",
        // M22 — high-risk ACs/derived requirements should have a negative or
        // boundary scenario. "warn" surfaces gaps without blocking; "required"
        // fails the run; "off" disables.
        riskCoverage: "warn",
        humanReviewBeforeUpload: true,
        humanReviewBeforePr: false,
      },
      // M22 — extra design passes (set false to skip the LLM calls / cost).
      design: { deriveRequirements: true, adversarialCritique: true },
      budgets: { maxCostPerRunUsd: 2, maxCostPerDayUsd: 20 },
      redactPatterns: ["Bearer [A-Za-z0-9._-]+", "Basic [A-Za-z0-9+/=]+"],
    },
    pr: { mention: "@manso", maxIterationsPerPr: 5 },
  };
}

const TEST_ARCHITECTURE_MD = `# Test Architecture

> Scaffolded by \`manso init\`. Fill in the TODO sections — Manso treats
> this file as the authority for how tests are structured in this repository.

## Frameworks

<!-- TODO: list the test frameworks and runners used (e.g. Playwright with
     playwright-bdd, Reqnroll, Cypress with cucumber-preprocessor, xUnit). -->

## Folder layout

<!-- TODO: where do feature files, step definitions, fixtures, and helpers live? -->

## Naming conventions

<!-- TODO: file naming, scenario naming, and tag conventions. -->

## Test data and fixtures

<!-- TODO: how is test data created? builders, factories, fixtures, seeding. -->

## Running tests

<!-- TODO: the exact commands to run the suite locally and in CI. -->
`;

const PRODUCT_CONTEXT_MD = `# Product Context

> Scaffolded by \`manso init\`. Optional but recommended — Manso uses this
> as a domain glossary when interpreting tickets.

## Overview

<!-- TODO: one paragraph on what this product does. -->

## Glossary

<!-- TODO: domain terms and their meanings. -->

## Key user journeys

<!-- TODO: the most important end-to-end flows. -->
`;

function testConventionsJson(): unknown {
  return {
    schemaVersion: "1.0.0",
    naming: {
      featureFiles: "kebab-case",
      stepDefinitions: "TODO",
    },
    locations: {
      features: "TODO",
      stepDefinitions: "TODO",
      fixtures: "TODO",
    },
    selectors: {
      strategy: "test-id",
      testIdAttribute: "data-testid",
    },
    testData: {
      secretsPolicy: "never-hardcode",
      factoriesPreferred: true,
    },
  };
}

const LEARNINGS_MD = `# Learnings

Durable rules captured from pull-request feedback. Manso appends entries
here; systemic learnings are also proposed as guideline or skill changes through
a separate, human-reviewed pull request.

<!-- entries are appended below -->
`;

const DECISIONS_MD = `# Decisions

Architectural and testing decisions log for this repository.

<!-- entries are appended below -->
`;

const AGENTS_MD = `# AGENTS.md

Authoritative testing guidance for this repository lives in the \`.agents/\` folder.

| Path | Purpose |
|---|---|
| \`.agents/manso.config.json\` | Stacks, output mode, providers, gates, policy |
| \`.agents/test-architecture.md\` | Frameworks, folder layout, conventions |
| \`.agents/test-conventions.json\` | Naming, locations, selectors, test-data rules |
| \`.agents/product-context.md\` | Domain glossary and product overview |
| \`.agents/guidelines/\` | Repo rules the agent must obey |
| \`.agents/skills/\` | Repo-specific skill overrides |
| \`.agents/memory/\` | Durable learnings and decisions |

Generated by \`manso init\`.
`;

const GUIDELINES_README_MD = `# Guidelines

Drop Markdown files here with rules Manso must obey when designing and
implementing tests for this repository (for example: "never use \`Thread.Sleep\`",
"always select by \`data-testid\`"). Every \`.md\` file in this folder is loaded.
`;

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Build the full set of files `manso init` writes into a repository:
 * the `.agents/` folder contents plus a root `AGENTS.md` interop anchor.
 */
export function buildTemplateFiles(input: TemplateInput): TemplateFile[] {
  return [
    { path: "AGENTS.md", content: AGENTS_MD },
    { path: ".agents/manso.config.json", content: stringifyJson(buildAgentConfig(input)) },
    { path: ".agents/test-architecture.md", content: TEST_ARCHITECTURE_MD },
    { path: ".agents/test-conventions.json", content: stringifyJson(testConventionsJson()) },
    { path: ".agents/product-context.md", content: PRODUCT_CONTEXT_MD },
    { path: ".agents/guidelines/README.md", content: GUIDELINES_README_MD },
    { path: ".agents/memory/learnings.md", content: LEARNINGS_MD },
    { path: ".agents/memory/decisions.md", content: DECISIONS_MD },
  ];
}
