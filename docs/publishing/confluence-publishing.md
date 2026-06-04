# Confluence Publishing

## Docs Root

The Confluence-ready docs root is:

```text
docs
```

The local publisher receives:

```yaml
docsPath: docs
```

## Publisher Behavior

The local publisher in `scripts/publish-confluence-docs.ts`:

1. Finds every Markdown file under `docs`.
2. Groups pages by the first subfolder.
3. Creates or updates a Confluence folder page for each group.
4. Uses each Markdown file's first H1 as the page title.
5. Converts Markdown to Confluence storage format.
6. Uploads supported local media as page attachments.
7. Writes storage snapshots and media snapshots into the pipeline work directory.

## Media Assets

The publisher supports the repository-docs pattern of keeping rendered diagrams and source diagrams together:

```markdown
![Rendered diagram](media/example.svg)

Source: [example.mmd](media/example.mmd)
```

Supported local media behavior:

| Markdown reference | Confluence behavior |
| --- | --- |
| `![alt](media/diagram.svg)` | Uploads the SVG as a page attachment and renders it as an image. |
| `[diagram.mmd](media/diagram.mmd)` | Uploads the Mermaid source as a page attachment and rewrites the link to that attachment. |
| Remote `https://...` images | Keeps the image as a remote Confluence image URL. |

Local media paths are resolved relative to the Markdown file that references them. The publisher creates a temporary placeholder page first when attachments are needed, uploads the files, and then replaces the placeholder with the final converted page body.

Current groups:

| Docs folder | Confluence folder page with default prefix |
| --- | --- |
| `overview` | `Manso Agent - Overview` |
| `operations` | `Manso Agent - Operations` |
| `reference` | `Manso Agent - Reference` |
| `publishing` | `Manso Agent - Publishing` |

## Pipeline Behavior

`.azure/azure-pipelines-tests.yml` includes the docs publish step after validation. The step runs only when:

- Validation succeeded.
- The build is running from `refs/heads/main`.
- Pipeline variable `confluenceDocsParentPageId` is configured.

The step uses:

```text
scripts/publish-confluence-docs.ts
```

Default publication settings:

| Setting | Value |
| --- | --- |
| Docs path | `docs` |
| Space key | `ATQ` |
| Page title prefix | `Manso Agent - ` |
| Pool | `bip-linux-vmss-test` |
| Credentials | Pipeline variables `manso-testing-agent-username` and `manso-testing-agent-jira-token` |

## First Publication Procedure

1. Create the parent page in Confluence.
2. Copy the numeric parent page id.
3. Configure pipeline variable `confluenceDocsParentPageId`.
4. Configure secret variables or a Key Vault-linked variable group for `manso-testing-agent-username` and `manso-testing-agent-jira-token`.
5. Run the validation pipeline from `main`.
6. Confirm the docs step publishes the expected folder pages and child pages.

For a dry run, set pipeline parameter `confluenceDocsDryRun=true` before the run.

## Page Title Rules

Use stable H1 titles because the publisher uses the first H1 as the Confluence page title.

Recommended shape:

```markdown
# Stable Page Title

## Section

Content.
```

Avoid changing H1 values unless a new Confluence page title is intended.

## Expected Page Tree

```text
<configured parent page>
  Manso Agent - Operations
    Manso Agent - CI Release And Publish
    Manso Agent - Consumer Repository Setup
    Manso Agent - Local Development
    Manso Agent - Troubleshooting
  Manso Agent - Overview
    Manso Agent - Manso Testing Agent
    Manso Agent - Source Layout
    Manso Agent - Manso Workflow Map
  Manso Agent - Publishing
    Manso Agent - Confluence Publishing
  Manso Agent - Reference
    Manso Agent - Artifacts And Memory
    Manso Agent - CLI Reference
    Manso Agent - Configuration Reference
    Manso Agent - LLM And Observability
    Manso Agent - Security And Permissions
```
