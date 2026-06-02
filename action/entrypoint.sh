#!/usr/bin/env bash
# Entrypoint for the ClaimCheck GitHub Action. Resolves the base and head SHAs
# (from the inputs, or automatically from the pull_request context), runs the
# CLI against the checked-out workspace, appends the verdict to the job summary,
# and propagates the verdict exit code (BLOCK fails the check).
set -euo pipefail

REPO="${INPUT_REPO:-/github/workspace}"
BASE="${INPUT_BASE:-}"
HEAD="${INPUT_HEAD:-}"
BUNDLE_OUT="${INPUT_BUNDLE_OUT:-${REPO}/.claimcheck}"
FAIL_ON_WARN="${INPUT_FAIL_ON_WARN:-false}"

# git refuses to operate on a workspace owned by another user; trust it.
git config --global --add safe.directory "${REPO}" || true

# Default head to the checked-out commit when the workflow did not pass one.
if [ -z "${HEAD}" ]; then
  HEAD="$(git -C "${REPO}" rev-parse HEAD)"
fi

# Default base to the merge base with the PR's base branch. The merge base, not
# the base branch tip, is the right parent: it keeps unrelated upstream commits
# out of the diff.
if [ -z "${BASE}" ] && [ -n "${GITHUB_BASE_REF:-}" ]; then
  git -C "${REPO}" fetch --no-tags --depth=1 origin "${GITHUB_BASE_REF}" 2>/dev/null || true
  BASE="$(git -C "${REPO}" merge-base "${HEAD}" "origin/${GITHUB_BASE_REF}" 2>/dev/null || echo "")"
fi

# A shallow checkout cannot resolve a base; say exactly how to fix it.
IS_SHALLOW="$(git -C "${REPO}" rev-parse --is-shallow-repository 2>/dev/null || echo false)"
if [ -z "${BASE}" ] && [ "${IS_SHALLOW}" = "true" ]; then
  echo "claimcheck: the checkout is shallow and no base could be resolved." >&2
  echo "claimcheck: add 'fetch-depth: 0' to actions/checkout, or pass the 'base' input." >&2
  exit 64
fi

ARGS=(run --repo "${REPO}" --head "${HEAD}" --bundle-out "${BUNDLE_OUT}" --annotations github)
if [ -n "${BASE}" ]; then
  ARGS+=(--base "${BASE}")
fi
if [ "${FAIL_ON_WARN}" = "true" ]; then
  ARGS+=(--fail-on-warn)
fi

set +e
OUTPUT="$(node /opt/claimcheck/dist/cli/run.js "${ARGS[@]}" 2>&1)"
CODE=$?
set -e

# Echo everything so the runner parses the ::warning/::error workflow commands
# and renders them inline on the PR diff.
echo "${OUTPUT}"

# The job summary shows the verdict text only; the workflow-command lines
# (prefixed with ::) are runner directives, not summary content.
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## ClaimCheck verdict"
    echo ""
    echo '```'
    echo "${OUTPUT}" | grep -v '^::' || true
    echo '```'
  } >> "${GITHUB_STEP_SUMMARY}"
fi

exit "${CODE}"
