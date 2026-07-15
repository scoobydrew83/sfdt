# Releasing `@sfdt/extension`

The Chrome extension is built and packaged with [WXT](https://wxt.dev). Releases
are cut from `main` by the **Extension CI** workflow (`.github/workflows/extension.yml`).

## Version source of truth

`extension/package.json` `version` is the single source of truth. WXT copies it
into the built manifest (`.output/chrome-mv3/manifest.json`) at build time, so the
two must always agree.

## Cut a release

1. Bump `version` in `extension/package.json`.
2. Move the `## [Unreleased]` notes in `extension/CHANGELOG.md` under a new
   `## [x.y.z] - <date>` heading.
3. Merge to `main`. The `release` job in `extension.yml` detects the version bump,
   tags `ext-vx.y.z`, creates a GitHub Release with the Chrome zip, and publishes
   to the Chrome Web Store.

Prerelease versions (containing `-`) are rejected by the release job.

## Packaging (local + CI)

```bash
npm run package:ext   # build flow-core + extension, verify version match, then zip
```

`package:ext` runs three steps in order: `build:ext`, the **version-match guard**,
then `wxt zip`. CI runs the same command in the `build` job.

### Version-match guard (P0-7)

`extension/scripts/check-version-match.ts` runs between build and zip. It compares
`extension/package.json`'s version against the built manifest
(`.output/chrome-mv3/manifest.json`) and **exits non-zero** if they differ, naming
both versions and the manifest path. This prevents shipping a stale zip whose
manifest lags the source version (the 0.5.0-vs-0.6.0 drift class).

Run it standalone against the current build:

```bash
node extension/scripts/check-version-match.ts
```

The comparison core is unit-tested in `extension/test/version-match.test.ts`.
