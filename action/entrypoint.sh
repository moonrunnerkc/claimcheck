#!/usr/bin/env bash
# Entrypoint for the ClaimCheck GitHub Action. Resolves the base and head SHAs,
# runs the CLI against the checked-out workspace, appends the verdict to the job
# summary, and propagates the verdict exit code (BLOCK fails the check).
set -euo pipefail

REPO="${INPUT_REPO:-/github/workspace}"
BASE="${INPUT_BASE:-}"
HEAD="${INPUT_HEAD:-}"
BUNDLE_OUT="${INPUT_BUNDLE_OUT:-${REPO}/.claimcheck}"
FAIL_ON_WARN="${INPUT_FAIL_ON_WARN:-false}"

if [ -z "${BASE}" ] || [ -z "${HEAD}" ]; then
  echo "claimcheck: base and head are required (set inputs base/head)" >&2
  exit 64
fi

# git refuses to operate on a workspace owned by another user; trust it.
git config --global --add safe.directory "${REPO}" || true

ARGS=(run --repo "${REPO}" --base "${BASE}" --head "${HEAD}" --bundle-out "${BUNDLE_OUT}")
if [ "${FAIL_ON_WARN}" = "true" ]; then
  ARGS+=(--fail-on-warn)
fi

set +e
OUTPUT="$(node /opt/claimcheck/dist/cli/run.js "${ARGS[@]}" 2>&1)"
CODE=$?
set -e

echo "${OUTPUT}"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## ClaimCheck verdict"
    echo ""
    echo '```'
    echo "${OUTPUT}"
    echo '```'
  } >> "${GITHUB_STEP_SUMMARY}"
fi

exit "${CODE}"
