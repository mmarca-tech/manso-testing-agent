#!/usr/bin/env bash

set -uo pipefail

usage() {
    cat <<'EOF'
Usage: scripts/run-ticket-workflow.sh --issue ABC-123 [options]

Runs the Jira ticket context, enrichment, review, and Xray generation workflow.

Required:
  --issue, -Issue VALUE

Options:
  --out, -Out VALUE                                      Default: ./out
  --config, -Config VALUE
  --install, -Install
  --build, -Build
  --skip-pr-changes, -SkipPrChanges
  --skip-confluence-impact, -SkipConfluenceImpact
  --skip-xray-review, -SkipXrayReview
  --skip-xray-generation, -SkipXrayGeneration
  --dry-run-generation, -DryRunGeneration
  --implement-xray-tests, -ImplementXrayTests
  --implementation-prompt-only, -ImplementationPromptOnly
  --allow-dirty-implementation, -AllowDirtyImplementation
  --test-implementation-command, -TestImplementationCommand VALUE
  --test-verification-command, -TestVerificationCommand VALUE
  --implementation-branch, -ImplementationBranch VALUE
  --implementation-target-branch, -ImplementationTargetBranch VALUE
  --implementation-repo, -ImplementationRepo VALUE
  --continue-on-optional-failure, -ContinueOnOptionalFailure
  -h, --help

Examples:
  ./scripts/run-ticket-workflow.sh --issue ABC-123 --out ./out --dry-run-generation
  ./scripts/run-ticket-workflow.sh --issue ABC-123 --out ./out --skip-pr-changes --skip-confluence-impact --dry-run-generation
  ./scripts/run-ticket-workflow.sh --issue ABC-123 --out ./out --implement-xray-tests --test-implementation-command "codex exec -"
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

format_command() {
    local formatted
    printf -v formatted '%q ' "$@"
    printf '%s' "${formatted% }"
}

workflow_log() {
    local elapsed=$((SECONDS - WORKFLOW_STARTED_AT))
    printf '[%s.0 s] %s\n' "$elapsed" "$1"
}

invoke_process_step() {
    local name="$1"
    local optional="$2"
    shift 2

    local step_started_at=$SECONDS
    local duration
    local exit_code

    printf '\n'
    workflow_log "Starting: $name"
    workflow_log "Command: $(format_command npm "$@")"

    npm "$@"
    exit_code=$?

    duration=$((SECONDS - step_started_at))
    if (( exit_code == 0 )); then
        workflow_log "Completed: $name in ${duration}.0s"
        return 0
    fi

    if [[ "$optional" == "true" && "$CONTINUE_ON_OPTIONAL_FAILURE" == "true" ]]; then
        printf 'Warning: %s failed after %s.0s, continuing because --continue-on-optional-failure was set. Exit code %s.\n' "$name" "$duration" "$exit_code" >&2
        return 0
    fi

    die "$name failed after ${duration}.0s. Exit code $exit_code."
}

ISSUE=""
OUT="./out"
CONFIG=""
INSTALL="false"
BUILD="false"
SKIP_PR_CHANGES="false"
SKIP_CONFLUENCE_IMPACT="false"
SKIP_XRAY_REVIEW="false"
SKIP_XRAY_GENERATION="false"
DRY_RUN_GENERATION="false"
IMPLEMENT_XRAY_TESTS="false"
IMPLEMENTATION_PROMPT_ONLY="false"
ALLOW_DIRTY_IMPLEMENTATION="false"
TEST_IMPLEMENTATION_COMMAND=""
TEST_VERIFICATION_COMMAND=""
IMPLEMENTATION_BRANCH=""
IMPLEMENTATION_TARGET_BRANCH=""
IMPLEMENTATION_REPO=""
CONTINUE_ON_OPTIONAL_FAILURE="false"

while (( $# > 0 )); do
    case "$1" in
        --issue=*)
            ISSUE="${1#*=}"
            shift
            ;;
        --issue|-Issue)
            require_value "$1" "$#"
            ISSUE="$2"
            shift 2
            ;;
        --out=*)
            OUT="${1#*=}"
            shift
            ;;
        --out|-Out)
            require_value "$1" "$#"
            OUT="$2"
            shift 2
            ;;
        --config=*)
            CONFIG="${1#*=}"
            shift
            ;;
        --config|-Config)
            require_value "$1" "$#"
            CONFIG="$2"
            shift 2
            ;;
        --install|-Install)
            INSTALL="true"
            shift
            ;;
        --build|-Build)
            BUILD="true"
            shift
            ;;
        --skip-pr-changes|-SkipPrChanges)
            SKIP_PR_CHANGES="true"
            shift
            ;;
        --skip-confluence-impact|-SkipConfluenceImpact)
            SKIP_CONFLUENCE_IMPACT="true"
            shift
            ;;
        --skip-xray-review|-SkipXrayReview)
            SKIP_XRAY_REVIEW="true"
            shift
            ;;
        --skip-xray-generation|-SkipXrayGeneration)
            SKIP_XRAY_GENERATION="true"
            shift
            ;;
        --dry-run-generation|-DryRunGeneration)
            DRY_RUN_GENERATION="true"
            shift
            ;;
        --implement-xray-tests|-ImplementXrayTests)
            IMPLEMENT_XRAY_TESTS="true"
            shift
            ;;
        --implementation-prompt-only|-ImplementationPromptOnly)
            IMPLEMENTATION_PROMPT_ONLY="true"
            shift
            ;;
        --allow-dirty-implementation|-AllowDirtyImplementation)
            ALLOW_DIRTY_IMPLEMENTATION="true"
            shift
            ;;
        --test-implementation-command=*)
            TEST_IMPLEMENTATION_COMMAND="${1#*=}"
            shift
            ;;
        --test-implementation-command|-TestImplementationCommand)
            require_value "$1" "$#"
            TEST_IMPLEMENTATION_COMMAND="$2"
            shift 2
            ;;
        --test-verification-command=*)
            TEST_VERIFICATION_COMMAND="${1#*=}"
            shift
            ;;
        --test-verification-command|-TestVerificationCommand)
            require_value "$1" "$#"
            TEST_VERIFICATION_COMMAND="$2"
            shift 2
            ;;
        --implementation-branch=*)
            IMPLEMENTATION_BRANCH="${1#*=}"
            shift
            ;;
        --implementation-branch|-ImplementationBranch)
            require_value "$1" "$#"
            IMPLEMENTATION_BRANCH="$2"
            shift 2
            ;;
        --implementation-target-branch=*)
            IMPLEMENTATION_TARGET_BRANCH="${1#*=}"
            shift
            ;;
        --implementation-target-branch|-ImplementationTargetBranch)
            require_value "$1" "$#"
            IMPLEMENTATION_TARGET_BRANCH="$2"
            shift 2
            ;;
        --implementation-repo=*)
            IMPLEMENTATION_REPO="${1#*=}"
            shift
            ;;
        --implementation-repo|-ImplementationRepo)
            require_value "$1" "$#"
            IMPLEMENTATION_REPO="$2"
            shift 2
            ;;
        --continue-on-optional-failure|-ContinueOnOptionalFailure)
            CONTINUE_ON_OPTIONAL_FAILURE="true"
            shift
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

[[ -n "$ISSUE" ]] || die "--issue is required."

WORKFLOW_STARTED_AT=$SECONDS
COMMON_ARGS=()
if [[ -n "$CONFIG" ]]; then
    COMMON_ARGS=(--config "$CONFIG")
fi

if [[ "$INSTALL" == "true" ]]; then
    invoke_process_step "Install dependencies" "false" install
fi

if [[ "$BUILD" == "true" ]]; then
    invoke_process_step "Build TypeScript" "false" run build
fi

workflow_log "Running ticket workflow for $ISSUE."

extract_args=(run extract-ticket -- --issue "$ISSUE" --out "$OUT" "${COMMON_ARGS[@]}")
invoke_process_step "Extract Jira ticket context" "false" "${extract_args[@]}"

if [[ "$SKIP_PR_CHANGES" != "true" ]]; then
    pr_args=(run summarize-pr-changes -- --issue "$ISSUE" --out "$OUT" "${COMMON_ARGS[@]}")
    invoke_process_step "Summarize linked pull request changes" "true" "${pr_args[@]}"
fi

if [[ "$SKIP_CONFLUENCE_IMPACT" != "true" ]]; then
    confluence_args=(run summarize-confluence-impact -- --issue "$ISSUE" --out "$OUT" "${COMMON_ARGS[@]}")
    invoke_process_step "Summarize Confluence impact" "true" "${confluence_args[@]}"
fi

if [[ "$SKIP_XRAY_REVIEW" != "true" ]]; then
    review_args=(run review-xray-tests -- --issue "$ISSUE" --out "$OUT" "${COMMON_ARGS[@]}")
    invoke_process_step "Review linked Xray tests" "true" "${review_args[@]}"
fi

if [[ "$SKIP_XRAY_GENERATION" != "true" ]]; then
    generation_args=(run generate-xray-tests -- --issue "$ISSUE" --out "$OUT" "${COMMON_ARGS[@]}")

    if [[ "$DRY_RUN_GENERATION" == "true" ]]; then
        generation_args+=(--dry-run)
    fi

    invoke_process_step "Generate Xray tests" "false" "${generation_args[@]}"
fi

if [[ "$IMPLEMENT_XRAY_TESTS" == "true" ]]; then
    implementation_args=(run implement-xray-tests -- --issue "$ISSUE" --out "$OUT" "${COMMON_ARGS[@]}")

    if [[ -n "$TEST_IMPLEMENTATION_COMMAND" ]]; then
        implementation_args+=(--agent-command "$TEST_IMPLEMENTATION_COMMAND")
    fi

    if [[ -n "$TEST_VERIFICATION_COMMAND" ]]; then
        implementation_args+=(--verify-command "$TEST_VERIFICATION_COMMAND")
    fi

    if [[ -n "$IMPLEMENTATION_BRANCH" ]]; then
        implementation_args+=(--branch "$IMPLEMENTATION_BRANCH")
    fi

    if [[ -n "$IMPLEMENTATION_TARGET_BRANCH" ]]; then
        implementation_args+=(--target-branch "$IMPLEMENTATION_TARGET_BRANCH")
    fi

    if [[ -n "$IMPLEMENTATION_REPO" ]]; then
        implementation_args+=(--repo "$IMPLEMENTATION_REPO")
    fi

    if [[ "$IMPLEMENTATION_PROMPT_ONLY" == "true" ]]; then
        implementation_args+=(--prompt-only)
    fi

    if [[ "$ALLOW_DIRTY_IMPLEMENTATION" == "true" ]]; then
        implementation_args+=(--allow-dirty)
    fi

    invoke_process_step "Implement generated Xray test cases" "false" "${implementation_args[@]}"
fi

printf '\n'
output_path="${OUT%/}/$ISSUE"
if [[ "$OUT" == "/" ]]; then
    output_path="/$ISSUE"
fi

total_duration=$((SECONDS - WORKFLOW_STARTED_AT))
workflow_log "Workflow completed for $ISSUE in ${total_duration}.0s. Outputs are under $output_path."
