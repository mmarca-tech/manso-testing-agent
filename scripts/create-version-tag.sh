#!/usr/bin/env bash
set -euo pipefail

tag_prefix="v"
default_bump="patch"
commit_message=""
remote_name="origin"

usage() {
  cat <<'USAGE'
Usage: scripts/create-version-tag.sh [options]

Options:
  --tag-prefix, -TagPrefix <value>          Tag prefix to match and create. Default: v
  --default-bump, -DefaultBump <value>      Default bump: patch, minor, or major. Default: patch
  --commit-message, -CommitMessage <value>  Commit message used to detect bump markers.
  --remote-name, -RemoteName <value>        Git remote to fetch and push tags. Default: origin
  -h, --help                                Show this help.
USAGE
}

die() {
  echo "$*" >&2
  exit 1
}

require_value() {
  local option="$1"
  local value_count="$2"

  if (( value_count < 2 )); then
    die "Missing value for $option."
  fi
}

while (( $# > 0 )); do
  case "$1" in
    --tag-prefix=*)
      tag_prefix="${1#*=}"
      shift
      ;;
    --tag-prefix|-TagPrefix)
      require_value "$1" "$#"
      tag_prefix="$2"
      shift 2
      ;;
    --default-bump=*)
      default_bump="${1#*=}"
      shift
      ;;
    --default-bump|-DefaultBump)
      require_value "$1" "$#"
      default_bump="$2"
      shift 2
      ;;
    --commit-message=*)
      commit_message="${1#*=}"
      shift
      ;;
    --commit-message|-CommitMessage)
      require_value "$1" "$#"
      commit_message="$2"
      shift 2
      ;;
    --remote-name=*)
      remote_name="${1#*=}"
      shift
      ;;
    --remote-name|-RemoteName)
      require_value "$1" "$#"
      remote_name="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

case "$default_bump" in
  patch|minor|major)
    ;;
  *)
    die "Default bump must be one of: patch, minor, major."
    ;;
esac

is_blank() {
  [[ ! "${1-}" =~ [^[:space:]] ]]
}

git_cmd() {
  local output

  if ! output="$(git "$@" 2>&1)"; then
    die "git $* failed:
$output"
  fi

  printf '%s\n' "$output"
}

get_bump_type() {
  local message="$1"
  local fallback="$2"
  local normalized

  if is_blank "$message"; then
    printf '%s\n' "$fallback"
    return
  fi

  normalized="$(printf '%s' "$message" | tr '[:upper:]' '[:lower:]')"

  if [[ "$normalized" =~ semver:[[:space:]]*major || "$normalized" =~ \#major || "$normalized" =~ \[major\] ]]; then
    printf '%s\n' "major"
    return
  fi

  if [[ "$normalized" =~ semver:[[:space:]]*minor || "$normalized" =~ \#minor || "$normalized" =~ \[minor\] ]]; then
    printf '%s\n' "minor"
    return
  fi

  if [[ "$normalized" =~ semver:[[:space:]]*patch || "$normalized" =~ \#patch || "$normalized" =~ \[patch\] ]]; then
    printf '%s\n' "patch"
    return
  fi

  printf '%s\n' "$fallback"
}

if ! is_blank "$commit_message"; then
  resolved_commit_message="$commit_message"
elif [[ -n "${BUILD_SOURCEVERSIONMESSAGE:-}" ]] && ! is_blank "$BUILD_SOURCEVERSIONMESSAGE"; then
  resolved_commit_message="$BUILD_SOURCEVERSIONMESSAGE"
else
  resolved_commit_message=""
fi

if [[ -n "${BUILD_SOURCEVERSION:-}" ]] && ! is_blank "$BUILD_SOURCEVERSION"; then
  source_version="$BUILD_SOURCEVERSION"
else
  source_version="$(git_cmd rev-parse HEAD | head -n 1)"
fi

if [[ -n "${BUILD_BUILDNUMBER:-}" ]] && ! is_blank "$BUILD_BUILDNUMBER"; then
  build_number="$BUILD_BUILDNUMBER"
else
  build_number="local"
fi

echo "Fetching tags from '$remote_name'."
git_cmd fetch "$remote_name" --tags --force >/dev/null

tag_pattern="${tag_prefix}[0-9]*.[0-9]*.[0-9]*"
current_tag="$(git_cmd tag --points-at HEAD --list "$tag_pattern" | head -n 1)"

if ! is_blank "$current_tag"; then
  echo "Commit already has semantic version tag '$current_tag'. Nothing to do."
  echo "##vso[task.setvariable variable=CreatedTag]$current_tag"
  exit 0
fi

latest_tag="$(git_cmd tag --list "$tag_pattern" --sort=-version:refname | head -n 1)"

if is_blank "$latest_tag"; then
  example_tag="${tag_prefix}1.0.0"
  die "No semantic version tags matching '$tag_pattern' were found. Create the first tag manually, for example '$example_tag'."
fi

version="${latest_tag#"$tag_prefix"}"
if [[ -n "$tag_prefix" && "$version" == "$latest_tag" ]]; then
  expected_format="${tag_prefix}X.Y.Z"
  die "Latest tag '$latest_tag' does not match the expected format '$expected_format'."
fi

if [[ ! "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  expected_format="${tag_prefix}X.Y.Z"
  die "Latest tag '$latest_tag' does not match the expected format '$expected_format'."
fi

major="${BASH_REMATCH[1]}"
minor="${BASH_REMATCH[2]}"
patch="${BASH_REMATCH[3]}"

bump_type="$(get_bump_type "$resolved_commit_message" "$default_bump")"
echo "Latest tag is '$latest_tag'. Selected bump type is '$bump_type'."

case "$bump_type" in
  major)
    major=$((major + 1))
    minor=0
    patch=0
    ;;
  minor)
    minor=$((minor + 1))
    patch=0
    ;;
  patch)
    patch=$((patch + 1))
    ;;
esac

next_tag="${tag_prefix}${major}.${minor}.${patch}"
echo "Creating tag '$next_tag' on commit $source_version."

tag_message="$(cat <<TAG_MESSAGE
Release $next_tag

Created by Azure DevOps build $build_number from commit $source_version.
TAG_MESSAGE
)"

git_cmd config user.name "Azure DevOps" >/dev/null
git_cmd config user.email "azure-devops@local" >/dev/null
git_cmd tag -a "$next_tag" -m "$tag_message" HEAD >/dev/null
git_cmd push "$remote_name" "refs/tags/$next_tag" >/dev/null

echo "Pushed tag '$next_tag'."
echo "##vso[task.setvariable variable=CreatedTag]$next_tag"
