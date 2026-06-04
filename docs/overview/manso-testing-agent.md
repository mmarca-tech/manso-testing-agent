# Manso Testing Agent

## Purpose

`manso-testing-agent` is a TypeScript and Node.js workflow package for turning Jira tickets into bounded QA artifacts and automated test implementation work. It collects evidence from Jira, Confluence, Azure DevOps, Xray Cloud, the local repository, and optional durable memory; validates workflow data with Zod; renders Markdown from the same validated JSON; and performs controlled writes only when a workflow explicitly allows them.

The package is designed for repeatable agentic testing workflows, not open-ended chat. Every public workflow has a clear input, output folder, schema, and mutation boundary.

## Public Workflows

| Command | Main use | Primary output | External writes |
| --- | --- | --- | --- |
| `generate-xray-tests` | Extract ticket evidence and design manual Xray tests. | `xray-test-generation.json` and `.md` | Yes, unless `--dry-run` |
| `implement-xray-tests` | Implement automated tests from generated or linked Xray scope. | `xray-test-implementation.json`, `.md`, prompt, and optional healing prompts | Yes, unless `--prompt-only` or `--dry-run` |
| `generate-release-notes` | Generate release notes from a release Jira ticket and linked issues. | `release-notes.json` and `.md` | Yes, unless `--no-upload` |
| `review-pull-request` | Review an Azure DevOps pull request against Jira and repository context. | `code-review.json` and `.md` | Yes, unless `--no-comment` |

The package also exposes TypeScript APIs for composing lower-level extractors, integrations, renderers, and workflow functions.

## Core Principles

- Use first-party APIs where possible: Atlassian REST and GraphQL, Azure DevOps REST, Xray Cloud GraphQL, OpenAI SDK, Anthropic SDK, and OpenTelemetry.
- Keep JSON contracts explicit and validated.
- Render Markdown from validated data, not separate hand-built summaries.
- Make mutating operations visible through flags such as `--dry-run`, `--prompt-only`, `--no-upload`, and `--no-comment`.
- Preserve traceability from generated tests, release notes, and reviews back to Jira, Confluence, Xray, pull request, and repository evidence.
- Keep implementation prompts constrained by repository guidance files.

## Package Facts

| Area | Value |
| --- | --- |
| Package name | `manso-testing-agent` |
| Current version | `2.5.1` |
| Runtime | Node.js 20 or newer |
| Language | TypeScript |
| Test runner | Vitest |
| Build output | `dist/` |
| Local output | `out/<scope>/` |
| Documentation root | `docs/` |
| Publish registry | Configured npm registry or Azure Artifacts feed |

## What This Documentation Covers

This docs folder is structured for Confluence publication. It covers package architecture, public workflows, local development, CI and release operations, CLI usage, configuration, durable memory, LLM observability, security, troubleshooting, and the Confluence publishing setup.
