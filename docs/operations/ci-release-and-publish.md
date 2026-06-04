# CI Release And Publish

## Validation Pipeline

Pipeline:

```text
.azure/azure-pipelines-tests.yml
```

Triggers:

- Pull requests to `main`.
- Pushes to `main`.

Validation steps:

1. Checkout repository.
2. Install Node.js 20.
3. Run `npm ci`.
4. Run `npm run check`.
5. Run `npm test`.
6. Run `npm run build`.
7. Run `npm run pack:dry-run`.

The same pipeline can publish the `docs/` folder to Confluence on `main` after validation when `confluenceDocsParentPageId` is configured.

Set parameter `confluenceDocsDryRun=true` to validate the Confluence conversion and page tree without writing pages.

## Version Tag Pipeline

Pipeline:

```text
.azure/azure-pipelines-version-tag.yml
```

Trigger:

- Pushes to `main`.

It validates the package, calculates the next semantic version, creates an annotated `vX.Y.Z` tag, and pushes the tag. By default it bumps patch version. The bump can be controlled from PR title or merge commit text:

- `#major`, `[major]`, or `semver:major`
- `#minor`, `[minor]`, or `semver:minor`
- `#patch`, `[patch]`, or `semver:patch`

## Publish Pipeline

Pipeline:

```text
.azure/azure-pipelines-publish.yml
```

Trigger:

- Tags matching `v*`.

It aligns the npm package version to the git tag, validates the package, authenticates the Azure Artifacts npm feed, and publishes `manso-testing-agent`.

## Package Contents

The package includes:

- `dist`
- `README.md`
- `.env.example`
- `scripts/run-ticket-workflow.ps1`

The Confluence docs are repository documentation and are not currently included in the npm package payload.

## Manual Release Fallback

When an automatic version tag is not suitable:

```powershell
git tag -a v2.5.2 -m "Release v2.5.2"
git push origin v2.5.2
```

The publish pipeline will run from the tag.

## Docs Publishing

The validation pipeline runs the local script:

```text
scripts/publish-confluence-docs.ts
```

This temporary local publisher avoids cross-project checkout permissions while the shared `rps-pipeline-templates` repository is not accessible from this package pipeline.

It publishes `docs/` only when:

- The validation stage succeeded.
- The source branch is `refs/heads/main`.
- Pipeline variable `confluenceDocsParentPageId` is non-empty.

The publishing step expects `manso-testing-agent-username` and `manso-testing-agent-jira-token` to be available as pipeline variables. Use secret variables or a Key Vault-linked variable group in the Azure DevOps pipeline configuration.

Set parameter `confluenceDocsDryRun=true` for the first publication check. Leave it false for the normal automatic main-branch publication.
