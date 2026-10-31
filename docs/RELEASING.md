# Manso releases

## Version contract

- `main` is the integration branch, not a consumer version.
- Releases have immutable annotated `vX.Y.Z` tags and a scoped npm package
  `@mmarca-tech/manso-testing-agent@X.Y.Z` in GitHub Packages.
- First release uses the validated `package.json` baseline (currently `0.1.0`).
  Later releases increment patch by default. Messages since the previous
  reachable release tag can request `#minor`, `[minor]`, `semver:minor` or the
  equivalent `major` markers. Highest severity wins; all commits are examined.
- A deliberately higher `package.json` version can establish a new baseline.
  Source manifests otherwise remain development baselines; the published
  archive's manifest and `manso --version` both match its tag.
- Release notes are in the annotated tag, the package's `CHANGELOG.md`, and the
  release pipeline artifact. They contain commit subjects and short SHAs.
- No moving npm range, dist-tag or unversioned package is a supported consumer
  pin. Upgrades require changing the exact version in the consumer pipeline.

## GitHub Actions

`.github/workflows/ci.yml` runs type-checking, tests, and the evaluation gate on
pull requests and pushes to `main`. Successful `main` pushes also publish the
`main` image to GHCR.

Start the `Release Manso` workflow manually from `main` to validate, create and
push the next annotated `vX.Y.Z` tag, publish the scoped npm package to GitHub
Packages, attach the package and changelog to a GitHub Release, and publish a
versioned container image to GHCR. The same workflow also publishes when a
stable `vX.Y.Z` tag is pushed directly. It uses `GITHUB_TOKEN` with
`contents: write` and `packages: write`; no PAT is needed for publishing. The
`.azure/.npmrc` file reads the token from `NODE_AUTH_TOKEN` and contains no
credential.

GitHub Packages defaults to private visibility. Consumers need a GitHub PAT
classic with `read:packages`; the Azure Jira runner also needs a Docker Registry
service connection for private GHCR images. Set the container package public if
anonymous pulls are preferred.

## Preview and recovery

```powershell
npm run release:plan
```

This is read-only: no fetch, tag, file edits or publishing.

If publishing fails after tagging, rerun `Release Manso` from `main`. The
release script reuses a tag already on the current commit and reconstructs the
same version. Do not delete or move a release tag. If GitHub Packages already
contains the version, publishing fails explicitly; inspect the existing
package and release artifact rather than overwrite it. A fix needs a new release.

Manual release runs can only be started from `main`; tag-triggered runs require
an exact stable `vX.Y.Z` tag. The release script rejects dirty or outdated
main checkouts and malformed tags.

## Shared-template upgrade

The `rps-pipeline-templates` update is a **major release**: existing
`templates/manso-pr-review-stage.yaml` and
`templates/manso-xray-implementation-stage.yaml` paths now run Manso.
Old tags preserve the Manso implementation. Consumers must deliberately
upgrade the template tag, migrate guidance to `.agents/`, and set the exact
npm package spec. The template version and npm version are independent pins.

```yaml
resources:
  repositories:
    - repository: rps-pipeline-templates
      type: git
      name: shared-quality-tools/pipeline-templates
      ref: refs/tags/vNEXT_MAJOR  # replace with the released template tag

stages:
  - template: templates/manso-pr-review-stage.yaml@rps-pipeline-templates
    parameters:
      packageSpec: '@mmarca-tech/manso-testing-agent@0.1.0' # choose a published release
      azureSubscription: your-key-vault-service-connection
      keyVaultName: your-key-vault
```

The template runner validates an exact stable package spec before installation,
installs from the same private feed into a fresh temporary directory, and
checks the CLI version before invoking it. Existing `manso-testing-agent-*`
Key Vault secret names are reused; no credential renaming is needed.

See the shared repository's template documentation for removed Manso-only
parameters and consumer requirements. Neither six-repository guidance migration
nor live package publication is performed by this code change.
