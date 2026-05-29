# ClaimCheck

A deterministic, pre-merge gate that tries to falsify a pull request's own claim about what it does, using only the PR and the repository. It does not trust the agent's tests. It attacks them.

## What it proves, and what it does not

ClaimCheck proves whether a PR's tests actually constrain the change the PR claims to make. It does not prove the change is semantically correct in the abstract.

A fix that is plausible but subtly wrong, with no failing invariant and no surviving mutant on the changed lines, will pass ClaimCheck. Catching that class of cheat requires a trusted specification or human judgment, which is a different tool and a different problem. ClaimCheck owns the part that can be made deterministic and replayable.

The three mechanical cheats it does catch:

1. **Claims to fix a bug, the bug is still there.** Caught when the fix-test passes against the unfixed parent, or when the changed lines can be mutated to a no-op and the test does not notice.
2. **Fixes the asked thing, quietly breaks something else.** Caught by differential regression: every test that passed on the parent must still pass on head.
3. **Hits an error and hides it.** Caught by an error-suppression scan on the changed lines.

## Verdict tiers

- **PASS.** Every check passed. The tests demonstrably constrain the claimed change and nothing that worked before is broken.
- **WARN.** A signal is present but ambiguous, or a check could not run deterministically. Annotates the PR; does not fail the gate.
- **BLOCK.** A check produced an unambiguous failure provable from the run alone: a no-op or condition-inverting mutant surviving on a covered changed line, a covered changed line with no mutant the test catches, a regression on a stable test, or a weakened existing assertion.

BLOCK is reserved for a provable lie. When in doubt, the verdict is WARN. A false block costs more than a missed cheat.

## The check battery (v0.1, fix mode)

- **test-touches-code**: the new tests must execute the changed source lines.
- **fails-on-parent**: applying only the test-file diff onto the parent, the new tests must fail there.
- **passes-on-head**: the new tests must pass on head.
- **assertion-reachability**: by def-use taint, the changed expression's value must flow into an assertion; if it never does, the test is vacuous.
- **kill-check**: Stryker mutates the covered changed lines; a surviving no-op/inversion mutant, or a line whose mutants all survive, means the test does not constrain the fix.
- **regression**: the parent tests the PR did not touch must still pass on head.
- **error-suppression**: swallowed exceptions and success-on-error-path returns on the changed lines.
- **test-weakening**: existing assertions loosened, removed, or skipped to fit the change.

assertion-reachability and the kill-check are two independent methods for the same property; they are cross-checked, and disagreement is surfaced as WARN rather than resolved silently.

## Determinism

The verdict is a pure function of a canonical, content-addressed evidence record. Test executions run inside a sandbox that pins the controllable nondeterminism sources (clock, randomness, high-resolution timer) and denies live network; tests that depend on an uncontrollable source are quarantined with that reason rather than sampled. Identical inputs reproduce an identical record, verdict, and bundle hash.

## Install

```
npm ci
npm run build
```

## CLI

```
# run against a PR locally (fix mode)
npx claimcheck run --repo <path> --base <parent-sha> --head <head-sha>

# write a replayable bundle
npx claimcheck run --repo <path> --base <sha> --head <sha> --bundle-out ./out

# reuse results for identical inputs
npx claimcheck run --repo <path> --base <sha> --head <sha> --cache-dir ./.cache

# replay a bundle: recompute the verdict from the record alone
npx claimcheck replay ./out/<hash>.bundle.json
```

Exit codes: `0` for PASS (and WARN, unless `--fail-on-warn`), `2` for BLOCK.

## GitHub Action

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: aftermath/claimcheck@v0
  with:
    base: ${{ github.event.pull_request.base.sha }}
    head: ${{ github.event.pull_request.head.sha }}
```

The Action runs in a hermetic container, writes the verdict to the job summary, and fails the check on BLOCK. The verdict bundle is written under `.claimcheck/` and is replayable by a third party from the bundle alone.

## Scope (v0.1)

TypeScript and JavaScript repositories using vitest, fix-mode claims. The language-adapter seam exists so a Python adapter is an addition rather than a rewrite. Claim classification, feature-add and refactor modes, and other languages are out of scope for v0.1.

## Verdict bundle

Content-addressed and replayable. It records the parent and head SHAs, the changed line ranges, the mutant manifest, the def-use chains, the flagged nondeterminism sources, the regressed and quarantined tests, the per-check results, and the tool version. The bundle hash is a function of those facts, so re-running the same inputs reproduces the same hash.
