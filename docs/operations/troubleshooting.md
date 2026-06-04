# Troubleshooting

## Workflow Failures

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Missing Jira REST config` | `JIRA_URL`, `JIRA_USERNAME`, or `JIRA_API_TOKEN` is missing. | Fill `.env` locally or configure CI secrets. |
| `Missing Xray Cloud config` | Xray credentials are missing for generation or linked test extraction. | Set `XRAY_BASE_URL`, `XRAY_CLIENT_ID`, and `XRAY_CLIENT_SECRET`. |
| Xray upload happened unexpectedly | `--dry-run` was not passed to `generate-xray-tests`. | Use `--dry-run` for local-only design. |
| Implementation edited the repository unexpectedly | `--prompt-only` or `--dry-run` was not passed. | Use prompt-only mode while inspecting prompts. |
| PR review did not post a comment | `--no-comment` was passed or Azure DevOps token lacks permission. | Remove `--no-comment` and verify token permissions. |
| Release notes did not upload | `--no-upload` was passed or Jira field update failed. | Remove `--no-upload` and verify target field permissions. |
| LLM call fails | Provider, model, key, base URL, or network access is incorrect. | Check `LLM_PROVIDER`, provider-specific env vars, and logs. |
| Validation healing loops repeatedly fail | Generated tests do not compile or fail verification after repair attempts. | Inspect `xray-test-implementation-prompt.md`, healing prompts, and verification output. |
| Memory write warning appears | Memory cabin is unavailable, dirty, or cannot push. | Fix memory remote access or set `MANSO_MEMORY_STRICT=false` for non-blocking behavior. |
| Memory workflow fails the command | `MANSO_MEMORY_STRICT=true` and memory mirroring failed. | Fix memory access or disable strict mode. |

## CI Failures

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `npm ci` fails | Lock file and package file disagree or registry access failed. | Update `package-lock.json` intentionally or fix feed auth. |
| `npm run check` fails | TypeScript errors. | Fix types before running tests. |
| `npm test` fails | Behavioral regression or test fixture drift. | Run the failing Vitest test locally. |
| `npm run build` fails | Build config catches a compile or emit issue. | Fix TypeScript source or build config. |
| `npm run pack:dry-run` misses expected files | `files` list in `package.json` is incomplete. | Update `package.json` intentionally. |
| Publish pipeline rejects tag | Tag does not match `vX.Y.Z`. | Use a semantic version tag such as `v2.5.2`. |

## Confluence Docs Publishing

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Docs stage is skipped | `confluenceDocsParentPageId` is empty, build is not on `main`, or validation failed. | Configure the variable and run from `main` after validation passes. |
| Duplicate page title error | A page title already exists outside the expected parent. | Adjust `confluenceDocsPageTitlePrefix` or rename the existing page. |
| Docs root not found | `docsPath` does not point to `docs`. | Check the pipeline template parameters. |
| Image publish fails | A local Markdown image reference points to a missing file. | Fix the image path or remove the reference. |
| Auth failure | Confluence email or API token is unavailable to the publish stage. | Verify Key Vault access and secret names. |

## Debug Order

Use this order for investigation:

1. Find the first non-zero command in the logs.
2. Open the generated JSON and Markdown artifacts in `out/<scope>/`.
3. Check warnings arrays in JSON outputs.
4. Re-run locally with the smallest non-mutating command.
5. Add or update tests for the failing behavior.

