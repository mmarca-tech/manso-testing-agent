# Manso Feature Wiki

A self-contained static HTML site documenting every Manso feature — with an
explanatory paragraph, the tech stack, how it works, and Mermaid diagrams
(components + workflows) for each.

## View it

Open **`wiki/index.html`** in a browser. No build step, **no network** — the
diagrams are pre-rendered PNGs in `diagrams/` (embedded as `<img>`), so they
display even offline or behind a strict proxy. `wiki.js` only does sidebar
scroll-spy.

Diagram **sources** live in `diagrams/*.mmd` (editable Mermaid). To regenerate
the PNGs after editing one, run **`node wiki/_gen.mjs`** (uses
`@mermaid-js/mermaid-cli` via `npx`). The pages reference the PNGs by name
(`diagrams/<page>-<n>.png`).

## Pages

| File | Covers |
|---|---|
| `index.html` | Overview, architecture, end-to-end workflow, feature catalog, tech stack, principles |
| `context.html` | Context Layer: providers, ADF→Markdown, linked tickets, attachments/vision, evidence graph, BM25 retrieval, agentic researcher |
| `design.html` | Test Design Engine, coverage gate, output modes, step reuse, data tables; Xray upload, link resolution, mandatory-field handling; coverage-gap analysis |
| `implementation.html` | Implementer (SDKs + MCP), verify/heal, branch/commit, design-file vs Xray-sourced `--issue`, VcsAdapter (Azure + GitHub), token-based push |
| `feedback.html` | PR feedback loop (`respond-to-pr`), learning engine, knowledge-update triggers, guideline-proposal PRs |
| `platform.html` | Governance (budgets, audit, redaction, sandbox, gates), observability, skills, MCP, configuration, eval harness |
| `operations.html` | CLI verb reference, Docker image, Azure pipelines, run modes, Jira automation rules, CI auth |

## Assets

- `styles.css` — shared styling.
- `wiki.js` — Mermaid initialization (modern theme) + sidebar scroll-spy.

The Mermaid diagram sources are inline in each page (`<pre class="mermaid">`).
All 16 diagrams are validated to render with `@mermaid-js/mermaid-cli`.
