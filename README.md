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
- **BLOCK.** A check produced an unambiguous failure provable from the run alone: a no-op or condition-inverting mutant surviving on a covered changed line, a covered changed line with no mutant the test catches, a regression on a stable test, a weakened existing assertion, a coverage-ignore on a changed line that taint proves no assertion observes, or a test that mocks the changed module while no changed line runs.

BLOCK is reserved for a provable lie. When in doubt, the verdict is WARN. A false block costs more than a missed cheat.

## The check battery (v0.1, fix mode)

- **test-touches-code**: the new tests must execute the changed source lines.
- **fails-on-parent**: applying only the test-file diff onto the parent, the new tests must fail there.
- **passes-on-head**: the new tests must pass on head.
- **assertion-reachability**: by def-use taint, the changed expression's value must flow into an assertion; if it never does, the test is vacuous.
- **kill-check**: Stryker mutates the covered changed lines; a surviving no-op/inversion mutant, or a line whose mutants all survive, means the test does not constrain the fix.
- **regression**: the parent tests the PR did not touch must still pass on head.
- **error-suppression**: swallowed exceptions and success-on-error-path returns on the changed lines.
- **static-tail**: coverage-ignore markers (istanbul/c8/v8/node:coverage), type-checker suppression (`@ts-ignore`/`@ts-nocheck`/`@ts-expect-error`), and `any` widening on the changed lines, plus parent-vs-head config weakening (lowered coverage thresholds, narrowed CI matrices), dropped `await`, and loosened `toBeCloseTo` tolerance. WARN by default; a coverage-ignore that taint confirms unconstrained escalates to BLOCK.
- **vacuous-assertion**: mock-the-SUT, snapshot acceptance over changed output, and tautologies in the new tests. WARN by default; mocking the changed module while no changed line runs escalates to BLOCK.
- **test-weakening**: existing assertions loosened, removed, or skipped to fit the change.

assertion-reachability and the kill-check are two independent methods for the same property; they are cross-checked, and disagreement is surfaced as WARN rather than resolved silently. The static-tail and vacuous-assertion checks surface the soft cheats that are decidable from the diff alone; each lands on the reviewer's diff as a per-line annotation (`--annotations github`).

## The undecidable tail (permanent scope)

Three cheats are out of scope by design, not for lack of time. Each needs an oracle for the intended behavior, and inferring that oracle from the PR alone reintroduces exactly the model-guessing ClaimCheck refuses to do. By Rice's theorem there is no sound, general procedure that decides them from the code under test:

- **wrong-cap / wrong-constant**: the test asserts a specific expected value, but that value is itself wrong. The test is non-vacuous and kills mutants; only a trusted specification knows the number should have been different.
- **snapshot of broken output**: a snapshot faithfully records the changed code's output, which happens to be the buggy output. The assertion is real; whether the captured value is correct is the open question.
- **exit-0-while-failed**: a test harness that reports success regardless of the assertions. Distinguishing a genuinely passing run from a rigged one requires trusting the very harness under suspicion.

ClaimCheck never claims to catch these and never silently passes them off as caught. The static-tail and vacuous-assertion checks deliberately stop at the decidable boundary: a *snapshot matcher over changed output* is flagged as a WARN (the pattern is decidable), but whether the captured value is *correct* is not, and ClaimCheck does not pretend to judge it. Closing this tail needs a different trust model (a spec or a human), which is what the oracle layer imports.

## Oracle layer (opt-in)

The battery above proves the PR's tests constrain the change; it still trusts the agent to have asserted the right thing. The oracle layer narrows that gap by importing a correctness signal from a source that is *not* the agent, so ClaimCheck can start catching the first undecidable-tail cheat (a non-vacuous test that asserts the wrong value) on the slice where an independent, machine-checkable signal exists. It never infers that signal from the PR; it runs one the human already wrote.

- **issue-repro (shipped).** A bug-fix PR usually links an issue whose body holds a human-written reproduction, written by the reporter before any fix existed. The oracle extracts a machine-parseable repro, runs it against head to assert the fixed behavior holds, and against parent to corroborate the bug reproduced there. A fix whose own tests pass but which fails the reporter's repro is a wrong-oracle catch, proven against an independent human source: **BLOCK**.
- **Registered behind the seam, not yet implemented:** metamorphic-relation, differential-on-unchanged-inputs, and property/contract oracles. Each takes its trusted signal as supplied, never inferred from the diff.

The rules match the rest of the tool. The layer is **opt-in and additive**: with no oracle configured and no oracle input, the evidence record is byte-for-byte what it is without the layer and the bundle hash is unchanged; a finding can tighten a verdict but never weaken or replace a battery check. **Deterministic or WARN**: an oracle that cannot evaluate its signal deterministically returns WARN, never a guess. **No freeform-repro guessing**: only a structured, machine-parseable repro (a fenced code block carrying an executable assertion) is run; a repro present but not machine-extractable is WARN ("repro present, not machine-extractable"), never a fabricated assertion. Fetching a linked issue is networked, so it lives only in the live tier; the deterministic core operates on issue text or a repro handed to it.

The load-bearing truth, never overclaimed: importing an oracle moves the trust boundary, it does not delete it. Detection completeness is bounded by oracle completeness. A wrong fix that satisfies every imported relation still passes.

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

A target repository is prepared with its own dependencies: a repo that declares dependencies is installed with its own lockfile (`npm ci`, or `npm install` when the lockfile is not npm's), and ClaimCheck's mutation tooling is overlaid so the kill-check runs against the repo's own vitest. A dependency-free repository (the corpus) borrows ClaimCheck's toolchain by symlink and stays offline.

## Testing tiers

- **Hermetic suite** (`npm test`, `npm run eval`): offline and deterministic. It runs against the synthetic corpus and the unit/integration checks, never touches the network, and is where the determinism guarantee and BLOCK precision are measured.
- **Live tier** (`npm run test:live`): networked and explicitly NOT part of the determinism guarantee. It clones a real external vitest repository and runs ClaimCheck against a historical fix PR via that repo's own install and test command. It needs network and a Node version compatible with the repo's vitest. The default suite excludes it (`*.live.test.ts`).

## Verdict bundle

Content-addressed and replayable. It records the parent and head SHAs, the changed line ranges, the mutant manifest, the def-use chains, the flagged nondeterminism sources, the regressed and quarantined tests, any oracle findings, the per-check results, and the tool version. The oracle findings field is omitted entirely when no oracle ran, so a run with no oracle hashes identically to one from before the layer existed. The bundle hash is a function of those facts, so re-running the same inputs reproduces the same hash.
