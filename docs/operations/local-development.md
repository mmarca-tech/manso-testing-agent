# Local Development

## Prerequisites

Install or verify:

- Node.js 20 or newer.
- npm.
- Git.
- PowerShell when using `scripts/run-ticket-workflow.ps1`.
- Access to Jira, Confluence, Azure DevOps, Xray Cloud, and LLM provider credentials when running live workflows.

## Install

From the repository root:

```powershell
npm ci
```

Use `npm install` only when intentionally updating dependencies.

## Local Configuration

Create a local `.env` from the example:

```powershell
Copy-Item .env.example .env
```

Fill only the secrets required for the workflow you are running. Do not commit `.env` or any local config with real credentials.

## Core Checks

Run the standard validation commands:

```powershell
npm run check
npm test
npm run build
npm run pack:dry-run
```

Use `npm run check` before committing TypeScript changes. Use `npm test` before merging behavioral changes.

## Local Workflow Examples

Generate an Xray plan without writing to Xray:

```powershell
npm run generate-xray-tests -- --issue ABC-123 --out ./out --dry-run
```

Generate an implementation prompt without editing a target repository:

```powershell
npm run implement-xray-tests -- --issue ABC-123 --out ./out --TestDesignEnabled true --prompt-only
```

Implement existing linked Xray tests without designing new tests:

```powershell
npm run implement-xray-tests -- --issue ABC-123 --out ./out --TestDesignEnabled false --prompt-only
```

Generate release notes without uploading to Jira:

```powershell
npm run generate-release-notes -- --issue ITSM-1234 --out ./out --no-upload
```

Review a pull request without posting a comment:

```powershell
npm run review-pull-request -- --out ./out --no-comment
```

## PowerShell Workflow Runner

The runner delegates to the package CLIs:

```powershell
.\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -DryRunGeneration
```

Useful examples:

```powershell
.\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -ImplementXrayTests -ImplementationPromptOnly -DryRunGeneration
.\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -ImplementXrayTests -TestVerificationCommand "npm test"
```

## Development Rules

- Keep generated `out/` and `dist/` files out of source control.
- Add or update tests with every behavioral change.
- Keep CLI behavior documented in `README.md` and this docs folder.
- Keep mutation flags clear and conservative.
- Do not make live external writes while developing unless the command and flags are intentional.

