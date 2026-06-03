# Releasing

The repo is intentionally release-free: `package.json` is `private: true` and
`UNLICENSED`, there is no `LICENSE` file, and no version tag has been pushed, so
nothing is published. `.github/workflows/release.yml` is wired up and waiting;
it runs only on a `vX.Y.Z` tag.

When you are ready to cut the first release, do these once:

## 1. Choose and add a license

The first tagged release should carry a license (the README promises this). Add
a `LICENSE` file and set the field:

```bash
npm pkg set license=MIT      # or Apache-2.0, BUSL-1.1, etc.
```

This is a one-way door for any version you publish; decide deliberately.

## 2. Make the package publishable

The name `claimcheck` is taken on npm, so publish under a scope (chosen:
`@moonrunnerkc/claimcheck`), and remove the private guard:

```bash
npm pkg set name=@moonrunnerkc/claimcheck
npm pkg set private=false
```

## 3. Add the npm credential

The release workflow publishes to npm only when an `NPM_TOKEN` secret exists
(an npm automation token with publish rights):

```bash
gh secret set NPM_TOKEN
```

Without it, the npm job no-ops and only the GHCR image publishes.

## 4. Point the Action at the prebuilt image (optional, after the first image)

Once the GHCR image exists, switch `action.yml` from building per-run to the
published image so consumers do not rebuild it:

```yaml
runs:
  using: docker
  image: docker://ghcr.io/moonrunnerkc/claimcheck:0.1.0
```

## 5. Tag and push

```bash
npm version 0.1.0   # or edit package.json version, then:
git tag v0.1.0
git push origin v0.1.0
```

The tag triggers `release.yml`: it builds and pushes
`ghcr.io/moonrunnerkc/claimcheck:0.1.0` (and `:latest`), and publishes the npm
package if steps 2 and 3 are done. CI must already be green on `master`.
