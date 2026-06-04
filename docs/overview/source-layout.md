# Source Layout

## Root Files

| Path | Purpose |
| --- | --- |
| `README.md` | High-level package documentation and examples. |
| `LIMITATIONS.md` | Known package limits. |
| `.env.example` | Local environment variable template. |
| `package.json` | Package metadata, scripts, dependencies, exported bins, and registry settings. |
| `package-lock.json` | Locked dependency graph for reproducible installs. |
| `tsconfig.json` | TypeScript editor and test config. |
| `tsconfig.build.json` | TypeScript build config for published package output. |
| `vitest.config.ts` | Vitest configuration. |
| `docker-compose.yml` | Local observability stack support. |
| `docs/` | Confluence-ready documentation. |

## Source Folders

| Folder | Responsibility |
| --- | --- |
| `src/*Cli.ts` | CLI entrypoints and CLI-compatible modules. |
| `src/config` | Runtime configuration loading and defaults. |
| `src/domain` | Zod schemas and domain contracts. |
| `src/integrations` | External system adapters for Atlassian, Azure DevOps, Xray, Confluence, LLMs, and git. |
| `src/memory` | Durable memory-cabin artifact mirroring and persona loading. |
| `src/output` | JSON and Markdown renderers and writers. |
| `src/shared` | Generic CLI, logging, argument, and utility helpers. |
| `src/workflows` | Workflow orchestration for each package capability. |

## Test Folders

| Folder | Responsibility |
| --- | --- |
| `test/*.test.ts` | Unit and workflow tests. |
| `test/fixtures` | Golden test fixtures and expected context data. |

## Build Output

The package builds TypeScript into:

```text
dist/
```

`dist/` is ignored by Git and included in the npm package through the `files` list in `package.json`.

## Runtime Output

Workflow commands write artifacts under:

```text
out/<issue-key>/
out/pr-<pull-request-id>/
```

`out/` is ignored by Git. Durable retention belongs in the memory cabin when configured.

