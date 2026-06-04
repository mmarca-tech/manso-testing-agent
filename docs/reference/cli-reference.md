# CLI Reference

## generate-xray-tests

Designs Xray tests from Jira and related evidence.

```powershell
npm run generate-xray-tests -- --issue ABC-123 --out ./out --dry-run
```

Common options:

| Option | Purpose |
| --- | --- |
| `--issue <key>` | Jira issue key. |
| `--context <path>` | Reuse an existing context file. |
| `--out <path>` | Output root. |
| `--dry-run` | Do not create or update Xray tests. |
| `--xray-test-review <path>` | Use a specific Xray review pack. |
| `--pr-changes <path>` | Use a specific PR changes pack. |
| `--confluence-impact <path>` | Use a specific Confluence impact pack. |

## implement-xray-tests

Implements automated tests from generated or linked Xray scope.

```powershell
npm run implement-xray-tests -- --issue ABC-123 --out ./out --TestDesignEnabled true --prompt-only
```

Common options:

| Option | Purpose |
| --- | --- |
| `--issue <key>` | Jira issue key. |
| `--xray-test-generation <path>` | Implement an existing generation pack. |
| `--repo <path>` | Target repository root. |
| `--out <path>` | Output root. |
| `--TestDesignEnabled true` | Generate a new test design before implementation. |
| `--TestDesignEnabled false` | Implement existing linked Xray tests. |
| `--prompt-only` | Generate implementation prompt without repository mutation. |
| `--dry-run` | Local-only mode; implies prompt-only for implementation. |
| `--verify-command <command>` | Verification command run after implementation. |
| `--heal-attempts <number>` | Maximum healing attempts after verification failure. |
| `--no-heal` | Disable verification healing. |
| `--target-branch <branch>` | Base branch. |
| `--branch <branch>` | Implementation branch. |
| `--reuse-branch-if-possible` | Reuse an active implementation PR or branch for the issue. |
| `--pr-title <title>` | Pull request title override. |
| `--pr-description <text>` | Pull request description override. |
| `--agent-command <command>` | Explicit shell command that reads prompt from stdin. |
| `--agent-path <path>` | Provider executable override. |
| `--agent-arguments <args>` | Arguments for an explicit agent command. |

## generate-release-notes

Generates release notes from a release ticket and linked issues.

```powershell
npm run generate-release-notes -- --issue ITSM-1234 --out ./out --no-upload
```

Common options:

| Option | Purpose |
| --- | --- |
| `--issue <key>` | Release Jira issue key. |
| `--out <path>` | Output root. |
| `--max-linked <number>` | Limit number of linked issues processed. |
| `--no-upload` | Do not write release notes back to Jira. |
| `--release-notes-field <field>` | Jira field to update. |
| `--field-format text` | Force plain text field update. |
| `--field-format adf` | Force Atlassian Document Format update. |

## review-pull-request

Reviews an Azure DevOps pull request and optionally posts a top-level PR thread.

```powershell
npm run review-pull-request -- --out ./out --no-comment
```

Common options:

| Option | Purpose |
| --- | --- |
| `--out <path>` | Output root. |
| `--ticket <key>` | Override Jira ticket detection. |
| `--no-comment` | Do not post a PR thread. |
| `--organization <name>` | Azure DevOps organization override. |
| `--project <name>` | Azure DevOps project override. |
| `--repository <name>` | Azure DevOps repository override. |
| `--pull-request-id <id>` | Pull request id override. |

## PowerShell Runner

The runner chains generation and optional implementation:

```powershell
.\scripts\run-ticket-workflow.ps1 -Issue ABC-123 -Out ./out -DryRunGeneration
```

Important switches:

| Switch | Purpose |
| --- | --- |
| `-Issue` | Jira issue key. |
| `-Out` | Output root. |
| `-DryRunGeneration` | Keep Xray generation local-only. |
| `-ImplementXrayTests` | Also run implementation. |
| `-ImplementationPromptOnly` | Generate implementation prompt only. |
| `-SkipXrayGeneration` | Implement existing linked Xray tests through `--TestDesignEnabled false`. |
| `-TestImplementationCommand` | Explicit implementation shell command. |
| `-TestVerificationCommand` | Verification command override. |

