#!/usr/bin/env bash

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: scripts/create-version-tag.sh [options]

Creates and pushes the next semantic version tag for HEAD.

Options:
  --tag-prefix, -TagPrefix VALUE              Default: v
  --default-bump, -DefaultBump patch|minor|major
                                               Default: patch
  --commit-message, -CommitMessage VALUE
  --remote-name, -RemoteName VALUE            Default: origin
  -h, --help

Examples:
  ./scripts/create-version-tag.sh
  ./scripts/create-version-tag.sh --default-bump minor --commit-message "Add feature #minor"
EOF
}

die() {
    printf 'Error: %s\n' "$1" >&2
    exit 1
}

require_value() {
    local option="$1"
    local remaining="$2"

    if (( remaining < 2 )); then
        die "$option requires a value."
    fi
}

is_blank() {
    local value="${1-}"
    [[ -z "${value//[[:space:]]/}" ]]
}

format_command() {
    local formatted
    printf -v formatted '%q ' "$@"
    printf '%s' "${formatted% }"
}

invoke_git() {
    local output

    if output=$(git "$@" 2>&1); then
        printf '%s\n' "$output"
        return 0
    else
        die "git $(format_command "$@") failed:
$output"
    fi
}

first_line() {
    local value="${1-}"
    printf '%s' "${value%%$'\n'*}"
}

get_bump_type() {
    local message="$1"
    local fallback="$2"
    local normalized

    if is_blank "$message"; then
        printf '%s' "$fallback"
        return 0
    fi

    normalized=$(printf '%s' "$message" | tr '[:upper:]' '[:lower:]')

    if [[ $normalized =~ semver:[[:space:]]*major || $normalized == *"#major"* || $normalized == *"[major]"* ]]; then
        printf 'major'
        return 0
    fi

    if [[ $normalized =~ semver:[[:space:]]*minor || $normalized == *"#minor"* || $normalized == *"[minor]"* ]]; then
        printf 'minor'
        return 0
    fi

    if [[ $normalized =~ semver:[[:space:]]*patch || $normalized == *"#patch"* || $normalized == *"[patch]"* ]]; then
        printf 'patch'
        return 0
    fi

    printf '%s' "$fallback"
}

TAG_PREFIX="v"
DEFAULT_BUMP="patch"
COMMIT_MESSAGE=""
REMOTE_NAME="origin"

while (( $# > 0 )); do
    case "$1" in
        --tag-prefix=*)
            TAG_PREFIX="${1#*=}"
            shift
            ;;
        --tag-prefix|-TagPrefix)
            require_value "$1" "$#"
            TAG_PREFIX="$2"
            shift 2
            ;;
        --default-bump=*)
            DEFAULT_BUMP="${1#*=}"
            shift
            ;;
        --default-bump|-DefaultBump)
            require_value "$1" "$#"
            DEFAULT_BUMP="$2"
            shift 2
            ;;
        --commit-message=*)
            COMMIT_MESSAGE="${1#*=}"
            shift
            ;;
        --commit-message|-CommitMessage)
            require_value "$1" "$#"
            COMMIT_MESSAGE="$2"
            shift 2
            ;;
        --remote-name=*)
            REMOTE_NAME="${1#*=}"
            shift
            ;;
        --remote-name|-RemoteName)
            require_value "$1" "$#"
            REMOTE_NAME="$2"
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

case "$DEFAULT_BUMP" in
    patch|minor|major)
        ;;
    *)
        die "--default-bump must be one of: patch, minor, major."
        ;;
esac

if ! is_blank "$COMMIT_MESSAGE"; then
    resolved_commit_message="$COMMIT_MESSAGE"
elif ! is_blank "${CI_COMMIT_MESSAGE-}"; then
    resolved_commit_message="$CI_COMMIT_MESSAGE"
else
    resolved_commit_message=""
fi

if ! is_blank "${CI_COMMIT_SHA-}"; then
    source_version="$CI_COMMIT_SHA"
else
    source_version="$(first_line "$(invoke_git rev-parse HEAD)")"
fi

if ! is_blank "${CI_PIPELINE_NUMBER-}"; then
    build_number="$CI_PIPELINE_NUMBER"
else
    build_number="local"
fi

if ! is_blank "${CI_SYSTEM_NAME-}"; then
    ci_system="$CI_SYSTEM_NAME"
elif ! is_blank "${CI-}"; then
    ci_system="CI"
else
    ci_system="local"
fi

printf "Fetching tags from '%s'.\n" "$REMOTE_NAME"
invoke_git fetch "$REMOTE_NAME" --tags --force >/dev/null

tag_pattern="${TAG_PREFIX}[0-9]*.[0-9]*.[0-9]*"
current_tag="$(first_line "$(invoke_git tag --points-at HEAD --list "$tag_pattern")")"

if ! is_blank "$current_tag"; then
    printf "Commit already has semantic version tag '%s'. Nothing to do.\n" "$current_tag"
    exit 0
fi

latest_tag="$(first_line "$(invoke_git tag --list "$tag_pattern" --sort=-version:refname)")"

if is_blank "$latest_tag"; then
    die "No semantic version tags matching '$tag_pattern' were found. Create the first tag manually, for example '${TAG_PREFIX}1.0.0'."
fi

version="${latest_tag#"$TAG_PREFIX"}"
if [[ ! $version =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    die "Latest tag '$latest_tag' does not match the expected format '${TAG_PREFIX}X.Y.Z'."
fi

major=$((10#${BASH_REMATCH[1]}))
minor=$((10#${BASH_REMATCH[2]}))
patch=$((10#${BASH_REMATCH[3]}))

bump_type="$(get_bump_type "$resolved_commit_message" "$DEFAULT_BUMP")"
printf "Latest tag is '%s'. Selected bump type is '%s'.\n" "$latest_tag" "$bump_type"

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
    *)
        patch=$((patch + 1))
        ;;
esac

next_tag="${TAG_PREFIX}${major}.${minor}.${patch}"
printf "Creating tag '%s' on commit %s.\n" "$next_tag" "$source_version"

tag_message="Release $next_tag

Created by $ci_system build $build_number from commit $source_version."

invoke_git config user.name "${GIT_AUTHOR_NAME:-CI}" >/dev/null
invoke_git config user.email "${GIT_AUTHOR_EMAIL:-ci@local}" >/dev/null
invoke_git tag -a "$next_tag" -m "$tag_message" HEAD >/dev/null
invoke_git push "$REMOTE_NAME" "refs/tags/$next_tag" >/dev/null

printf "Pushed tag '%s'.\n" "$next_tag"
