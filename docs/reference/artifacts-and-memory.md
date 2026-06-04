# Artifacts And Memory

## Local Artifacts

Issue-based workflows write to:

```text
out/<issue-key>/
```

Pull request review writes to:

```text
out/pr-<pull-request-id>/
```

Common artifact pairs:

| Files | Workflow |
| --- | --- |
| `context.json` and `context.md` | Ticket context extraction. |
| `xray-test-review.json` and `.md` | Existing Xray coverage review. |
| `pr-changes.json` and `.md` | Pull request diff summary. |
| `confluence-impact.json` and `.md` | Linked Confluence impact summary. |
| `xray-test-generation.json` and `.md` | Generated or linked Xray implementation scope. |
| `xray-test-implementation-prompt.md` | Prompt sent to implementation agent. |
| `xray-test-implementation.json` and `.md` | Implementation result. |
| `xray-test-healing-attempt-<n>.md` | Verification healing prompt or output. |
| `release-notes.json` and `.md` | Release note output. |
| `code-review.json` and `.md` | Pull request review output. |

JSON is the machine-readable source of truth. Markdown is the review surface for humans.

## Memory Cabin

The memory cabin mirrors generated artifacts into a durable repository or filesystem path. Enable it with:

```env
MANSO_MEMORY_ROOT=https://your-git-host/your-org/manso-memory-cabin.git
MANSO_MEMORY_ENABLED=true
```

When `MANSO_MEMORY_ROOT` is a Git URL, the package clones it into the configured cache directory or the default:

```text
~/.manso/memory-cabins
```

The memory root receives:

```text
artifacts/<scope>/<id>/latest/
artifacts/<scope>/<id>/runs/<timestamp>-<workflow>/
```

Each mirrored artifact set also has a `manifest.json` with schema version, updated timestamp, workflow, scope, source directory, and files.

## Memory Scopes

| Scope | Example | Meaning |
| --- | --- | --- |
| `jira` | `ABC-123` | Issue-based workflow output. |
| `pull-request` | `pr-42` | Pull request review output. |
| `misc` | `ad-hoc` | Output directory that does not look like a Jira key or PR id. |

## Git Memory Behavior

When the memory root is a Git repository:

1. Clean clones are refreshed with `git fetch` and `git pull --ff-only`.
2. Dirty clones are left as-is.
3. New artifacts are committed with service identity defaults when no git identity exists.
4. Direct push is attempted first.
5. If direct push is rejected, the package pushes a `manso-memory/<scope>/<id>` branch.
6. For Azure DevOps memory remotes, the package opens or updates a pull request back to the target memory branch.

Memory writes are non-blocking by default. Set `MANSO_MEMORY_STRICT=true` to fail the workflow when memory mirroring fails.

## Juana Persona In Memory

The memory root can provide the editable persona file:

```text
persona/juana-manso.md
```

When the file exists and is non-empty, LLM-backed workflows use it instead of the packaged fallback persona.

