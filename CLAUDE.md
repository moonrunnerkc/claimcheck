# CLAUDE.md

Operating rules for building ClaimCheck. Read `claimcheck-build-plan.md` for the full architecture and the phased plan. This file is the standing constitution; when the two conflict, this file wins on rules and the plan wins on architecture.

## What ClaimCheck is

A deterministic, pre-merge gate that tries to falsify a pull request's own claim about what it does, using only the PR and the repository. It does not trust the agent's tests. It attacks them.

## The scope boundary, non-negotiable

ClaimCheck proves whether a PR's tests actually constrain the change the PR claims to make. It does not prove the change is semantically correct in the abstract.

Never write code, a comment, a log line, a doc, or a commit message that claims or implies more than that. A plausible-but-wrong fix with no failing invariant and no surviving mutant on the changed lines will pass, and that is acceptable and stated openly. Overclaiming is the failure mode that ends this project.

## Prime directives

1. **Determinism is the product.** A non-deterministic verdict is a defect. The same inputs must always produce the same verdict and the same bundle hash. Flaky tests are quarantined and never affect a verdict. If you cannot make a check deterministic, it returns WARN, not a guess.
2. **BLOCK only on a provable lie.** Three tiers: PASS, WARN, BLOCK. BLOCK is reserved for failures provable from the run alone: a logic-altering mutant surviving on a covered changed line, a stable test that regressed, a weakened existing assertion. Everything ambiguous is WARN. BLOCK precision is the primary metric and is held at 1.0 on the corpus. A false block costs more than a missed cheat.
3. **Orchestrate, do not reinvent.** Mutation testing is Stryker's job. Do not reimplement a mutation engine. The IP here is the claim-to-probe mapping: diff-hunk to mutate-range, coverage-targeted mutant selection, the fails-on-parent harness, flake quarantine, the verdict tiering, and the replayable bundle.
4. **Do not use naive `--since`.** It re-mutates whole changed files and everything a changed test touches, which times out CI. Compute diff hunks, intersect with coverage, and pass explicit `--mutate "path:start-end"` ranges scoped to the lines the new test covers.

## Engineering standards

- TypeScript strict mode. No `any`, ever. No implicit `any`.
- Named exports only. No default exports.
- Kebab-case filenames.
- Full JSDoc on every public function.
- 300-line ceiling per file. Decompose before you reach it.
- DRY at three repetitions, not before.
- SOLID applied pragmatically, not dogmatically.
- Error messages state what failed and what to do about it.
- No mocks for anything that can be tested directly. The git layer, the mutation runner, and the checks run against real repositories and real Stryker output in tests.

## Testing

- Every function has at least one test.
- Test names describe the behavior, not the implementation. A test should be understandable without reading the code it covers.
- Tests validate real behavior, not wiring.
- Integration tests over unit tests where the boundary is the point, which for this project is most of it: the checks are only meaningful against real commits and real mutants.
- The evaluation corpus in `eval/corpus/` is part of the test surface. Detection changes are validated against it.

## Writing style for all output

- No em dashes anywhere, including code comments and docs. Use commas, colons, semicolons, parentheses, or separate sentences.
- All code reads as human-written. No AI-typical patterns, no generic variable names, no over-commenting obvious logic, no boilerplate filler.
- Comment intent and non-obvious decisions, not the syntax.

## The check battery, v0.1

Fix mode only. Seven checks, defined in the build plan: test-touches-code, fails-on-parent, passes-on-head, kill-check, regression, error-suppression, test-weakening. Checks 4 and 5 are decisive; the rest are pre-filters or supporting signals.

## The verdict bundle contract

Content-addressed and replayable. It records: parent and head SHAs, changed line ranges, the mutant manifest with its seed, per-check results, the quarantined test list, and the tool version. The bundle hash is a function of inputs and results. Re-running the same inputs reproduces the same hash.

## Out of scope for v0.1

Do not build these. They are scope-volcano risks and some reintroduce the model-guessing this tool exists to avoid.

- Claim classification by NLP. v0.1 is told it is a fix; it does not infer the claim type.
- Feature-add and refactor claim types. Fix mode first, expand after the case study.
- Languages other than TypeScript and JavaScript. The language adapter interface exists so Python is a v0.2 addition, not a rewrite. Do not implement it yet.
- Deep test-machinery tamper forensics. ClaimCheck does the diff-level test-weakening slice only.

## Commands

```
# install
npm ci

# unit and integration tests
npm test

# run ClaimCheck against a PR locally (fix mode)
npx claimcheck run --repo <path> --base <parent-sha> --head <head-sha>

# run the evaluation corpus and print precision, recall, determinism
npm run eval
```

## Definition of done for any change

A change is done when: it holds determinism (identical verdict and bundle hash across reruns), it does not lower BLOCK precision below 1.0 on the corpus, it has behavior-focused tests, and its output respects the scope boundary at the top of this file.
