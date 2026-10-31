# Optional Memory Cabin

Memory Cabin is a supplemental cross-repository store for generated artifact
history and curated reference knowledge. It is **disabled by default** and does
not replace, rewrite or synchronize `.agents/memory/learnings.md`,
`.agents/memory/decisions.md`, repository guidance or the local audit log.

Use local memory for current project decisions. Enable a cabin when multiple
repositories need durable run history or deliberately curated shared patterns.
Merely specifying a root does **not** enable the feature.

## Opt in

For a filesystem cabin outside the target repository:

```powershell
$env:MANSO_MEMORY_ENABLED = "true"
$env:MANSO_MEMORY_ROOT = "C:\shared\manso-memory"
manso design-tests --issue QATG-123 --repo C:\repos\example
```

For a private Git cabin:

```powershell
$env:MANSO_MEMORY_ENABLED = "true"
$env:MANSO_MEMORY_ROOT = "https://dev.azure.com/organization/project/_git/memory"
$env:MANSO_MEMORY_BRANCH = "main"
manso implement-tests --repo C:\repos\example --design .\out\QATG-123\test-design.json
```

Initialize the remote branch with a first commit before use. Supply credentials
through the existing `AZURE_DEVOPS_PAT` / `SYSTEM_ACCESSTOKEN` or
`GITHUB_TOKEN` / `GH_TOKEN` configuration. They are used for both Git HTTP
authentication and fallback PR creation, never saved to Git config. SSH and
local credential helpers also work for Git; PR creation still needs a supported
Azure DevOps/GitHub adapter and API credentials. Never embed credentials in a
remote URL.

Non-secret settings can instead live in the JSON file passed via `--config`:

```json
{
  "memoryCabin": {
    "enabled": true,
    "root": "C:\\shared\\manso-memory",
    "branch": "main",
    "strict": false,
    "readContext": true,
    "maxContextChars": 8000
  }
}
```

| Setting | Default | Environment override |
|---|---|---|
| `enabled` | `false` | `MANSO_MEMORY_ENABLED` |
| `root` | unset; required when enabled | `MANSO_MEMORY_ROOT` |
| `branch` | `main` | `MANSO_MEMORY_BRANCH` |
| `cacheDir` | `~/.manso/memory-cabins` | `MANSO_MEMORY_CACHE_DIR` |
| `strict` | `false` | `MANSO_MEMORY_STRICT` |
| `readContext` | `true` | `MANSO_MEMORY_READ_CONTEXT` |
| `maxContextChars` | `8000`, maximum `16000` | JSON only |

Boolean environment values accept `true`/`false`, `1`/`0`, `yes`/`no` and
`on`/`off`, case-insensitively; blank and unmapped `$(NAME)` pipeline
variables count as unset. Memory is optional, so an unrecognised value or other
misconfiguration only warns and leaves the cabin off. A cabin that was
explicitly enabled and is misconfigured still fails. Set
`MANSO_MEMORY_ENABLED=false` to disable a configured cabin. Set
`readContext=false` to retain artifact history without adding shared prompt
context. A zero character limit also suppresses context reads.

## Artifact history and delivery

Supported workflows are test design, implementation, coverage analysis and
PR feedback. Standard writers register the exact context, design, feature,
manual-test, implementation, implementation-prompt and learning files they
generate. Coverage analysis also persists `coverage-analysis.json`.

The independent PR-review, release-notes and incident-triage feature branches
are not bundled into this change. When those verbs are available, the CLI
captures only newly created/updated `code-review.{json,md}`,
`release-notes.{json,md}` and `incident-analysis.{json,md}` at their established
output paths. Unchanged files from previous invocations are not mirrored.
Arbitrary output-directory contents, credentials, raw source code, binaries,
audit logs and local memory are not recursively ingested.

```text
knowledge/
  shared-patterns.md
artifacts/
  repo-<repository identity hash>/
    <workflow>-<hash>/
      <scope>-<hash>/
        latest/
          manifest.json
          <registered files>
        runs/
          <timestamp>-<uuid>/
            manifest.json
            <registered files>
```

Repository namespaces use the target repository's origin, falling back to its
canonical local path when no origin exists. Use `--repo` for the intended target;
otherwise the CLI uses `BUILD_SOURCESDIRECTORY` or its current directory.
Library sessions without a target use an explicit `unscoped` namespace.
Scope paths distinguish different output subdirectories. Manifests include
relative artifact names and SHA-256 checksums, not source paths or remote URLs.
Failed workflows retain registered artifacts and set `failed: true`.

Filesystem cabins write locally. Git cabins use an independent clean checkout,
fetch the configured branch into a detached checkout, commit only generated
snapshots and try a direct push. If the push is rejected, Manso pushes a
unique `manso-memory/<run-id>` branch and opens a PR to the configured
branch. Pending PR artifacts remain on that branch until merged, so they do not
appear on the main cabin branch yet. Grant only the read/write and PR permissions
needed for the cabin repository. A local Git root must have an origin and an
existing configured branch; dirty checkouts are refused.

## Supplemental knowledge

Only curated, top-level `knowledge/*.md` files are read as shared context.
Artifact history is **not** automatically turned into authoritative memory.
Up to eight Markdown files are loaded in filename order, redacted and bounded
by the configured character limit. Truncation is visible and audited.

This context is JSON-escaped and labelled **historical reference, not
instructions or current requirements**. Current local guidance, local memory,
ticket evidence, schemas and tests take precedence. It supplements design and
coverage analysis prompts. It is deliberately excluded from acceptance-criteria
extraction and from implementation prompts: the implementation agent can run
commands and write files, so shared knowledge never reaches it. Implementation
runs still register their artifacts. Shared knowledge never overrides a persona
or changes local knowledge files. This labelling is defense in depth, not a
guarantee against prompt injection: protect the cabin's `knowledge/` folder with
a branch policy that requires review, and restrict who can change it. Anything
merged there influences design and coverage prompts in every repository that
enables the cabin.

## Governance and failures

- Existing built-in secret/PII redaction and repository
  `policy.redactPatterns` apply to exported text, JSON keys/values and filenames,
  shared knowledge and memory audit messages. Configured credential values are
  additionally scrubbed. Invalid custom regexes fail closed.
- JSON remains valid after redaction. Paths that collide after redaction or
  with the generated `manifest.json` are rejected rather than overwritten.
- Only UTF-8 `.json`, `.md` and `.feature` artifacts are accepted. Each file
  must be at most 2 MiB; a run is limited to 100 files and 10 MiB before
  redaction. Source/root/knowledge symlinks and path escapes are rejected.
- Cabin roots must remain outside the target repository, including through
  junctions. Exclusive lock files serialize sessions sharing one cabin.
- Memory operations append `memory.read`, `memory.mirrored` and `memory.failed`
  entries to the existing audit log (`MANSO_AUDIT_LOG` or `out/audit.jsonl`).
  Delivery is not reported as completed when a push/PR or audit write fails.
- Default storage, read, Git and audit failures **warn and continue** the main
  workflow. `strict=true` makes those failures fatal. Configuration errors
  remain errors. If both the workflow and strict mirroring fail, an
  `AggregateError` preserves both causes.
- Disabled sessions and CLI `--dry-run`/help perform no cabin I/O. No fallback
  local-memory mutation occurs when the cabin is unavailable.

Redaction is not anonymization: business descriptions, identities not covered
by configured patterns and sensitive domain facts may remain. Review the
data policy before enabling cross-repository export or sending shared context
to the configured LLM. Restrict cabin/cache access, define a retention policy,
and clean up obsolete runs/PR branches under that policy. There is no automatic
history deletion or Git-history purging.

Locks are never stolen. If a process crashes, verify the recorded PID is no
longer running before removing the exact `<root>.lock` file. For remote cabins
the root is the hashed checkout directory under `cacheDir`.

## Library use and new writers

Library functions do not implicitly enable cabin access from the environment.
Wrap a workflow explicitly; standard writers register automatically:

```typescript
import { MemoryCabinConfigSchema, withMemoryCabin } from "manso";

await withMemoryCabin({
  config: MemoryCabinConfigSchema.parse({
    enabled: true,
    root: "C:\\shared\\manso-memory"
  }),
  workflow: "design-tests",
  repoRoot: "C:\\repos\\example",
  outDir: "C:\\repos\\example\\out",
  secrets: [configuredApiKey],
  redactPatterns: ["custom-sensitive-pattern"]
}, async () => {
  await generateAndWriteDesign();
});
```

New artifact writers should call
`registerCabinArtifacts({ directory, paths: [generatedPath] })` **after**
successfully writing each set. Registration is a no-op outside a session.
Custom prompts can call `supplementalCabinContext()` for the labelled reference
block. For a legacy writer, `captureArtifacts` accepts exact candidate paths
and captures only files whose metadata changed during the session.
Never register runtime config, credentials, arbitrary repository files or
unreviewed local memory.
