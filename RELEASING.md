# Releasing sfdt

Five workspaces, different cadences:

| Workspace | Distribution | Versioning |
|---|---|---|
| `@sfdt/cli` | npm; also drives the Homebrew tap, the GHCR Docker image, and the composite GitHub Action's floating tag | Independent semver (`package.json`, tag `vX.Y.Z`). Most releases come from here. |
| `@sfdt/flow-core` | npm, published by `ci.yml` as a coupled sub-step of every CLI release (**before** the CLI — the CLI's runtime dep must resolve first). No standalone trigger. | Bumps with the CLI's release commit. |
| `@sfdt/plugin` | npm (`sf plugins install @sfdt/plugin`), published by `ci.yml` **after** the CLI so its `@sfdt/cli` dep resolves | Bumps with the CLI's release commit. |
| `@sfdt/extension` | Chrome Web Store, auto-uploaded by `extension.yml` (tag `ext-vX.Y.Z`) | Independent semver in `extension/package.json`. Web Store review is slow — bump on its own schedule. |
| `sfdt-devtools` (`/vscode`) | VS Code Marketplace as `sfdt.sfdt-devtools` (+ Open VSX), via `vscode-release.yml` (tag `vscode-vX.Y.Z`) | Independent semver in `vscode/package.json`. |

`@sfdt/host` has no independent release — it ships inside `@sfdt/cli`.

## Wire-protocol version (`PROTOCOL_VERSION`)

Lives in `packages/flow-core/src/bridge-contract.ts`, exchanged on `/api/bridge/ping`.
Same major+minor → ok; same major, different minor → warn; different major → refuse to talk.

- Bump **MINOR** for additive changes: new `SfdtRequestKind`, new optional response field, new error code.
- Bump **MAJOR** for breaking ones: removed kind, renamed required field, changed field type, removed legacy fallback.
- A protocol bump is separate from any package version; patch releases don't touch it.

When bumping:

1. Edit `PROTOCOL_VERSION` in `bridge-contract.ts` and add a line to its changelog comment block.
2. Update the tests in `test/lib/bridge-routes.test.js`, `extension/test/sfdt-bridge.test.ts`, and `packages/flow-core/test/protocol-version.test.ts`.
3. `npm run build:flow-core`.

**Never ship a breaking (major) protocol change in the CLI before the matching extension has cleared Web Store review** — see the rollback playbook (§6).

## 1. The normal path: CI-first

**You do not run `npm publish`.** `.github/workflows/ci.yml` publishes; your job is to land a
version-bump commit on the right branch and let CI do the rest.

### Stable release (push to `main`)

Triggers when `package.json#version` changed — or when the version isn't yet npm's `latest`,
so a previously failed publish **self-heals** on the next push to `main`. The `publish` job, in order:

1. Tags `vX.Y.Z` and force-moves the floating major tag (`v0` today) so `uses: scoobydrew83/sfdt@v0` resolves to the newest stable. Betas never move it.
2. Builds the GUI; pins npm 11.x (OIDC trusted publishing + `--provenance`; no token).
3. Publishes **`@sfdt/flow-core` → `@sfdt/cli` → `@sfdt/plugin`**, in that order. Each step is idempotent — republishing an already-published version is tolerated, which is what makes the self-healing re-run safe.
4. Creates the GitHub Release (`--generate-notes`).
5. Bumps the Homebrew tap (`scoobydrew83/homebrew-sfdt`, `Formula/sfdt.rb` url + sha256). Needs the `HOMEBREW_TAP_TOKEN` fine-grained PAT and runs `continue-on-error` — a failure is a yellow step, not a red run. Check it; bump the tap manually if it skipped. The tap repo is the single source of truth for the formula.
6. The downstream `docker` job calls the reusable `docker-publish.yml` via `workflow_call` in the **same run** (a `GITHUB_TOKEN`-created Release doesn't fire downstream workflows), pushing `ghcr.io/scoobydrew83/sfdt:X.Y.Z` + `:latest`. Re-publish a version on demand via `workflow_dispatch` with the version input.
7. Syncs the standalone skills pack repo (`scoobydrew83/sfdt-skills`, backs `npx skills add`) by running `sfdt skills export --target pack`, which regenerates `skills/` + `manifest.json` **and bumps the README "Synced from `@sfdt/cli` vX.Y.Z" footer from `package.json`** so it can't drift (harness H-014). Needs the `SKILLS_PACK_TOKEN` fine-grained PAT and runs `continue-on-error` — a downstream distribution sync must never fail a published release. To sync by hand, run `sfdt skills export --target pack --out ../sfdt-skills` (the footer bump is in the command, not the CI job).

A prerelease version (`X.Y.Z-*`) on `main` **fails the job** by design — prereleases publish from `develop`.

### Beta release (push to `develop`)

A version change to a prerelease (`X.Y.Z-beta.N`) triggers `publish-beta`: tag, publish
flow-core/CLI/plugin under the `beta` dist-tag, GitHub Pre-Release. No Docker, no Homebrew,
no floating-tag move.

### PR beta channel

Label a PR `publish-beta` (`pr-publish.yml`; write-permission actors only): publishes
`X.Y.Z-pr.<N>.<n>` under dist-tag `pr-<N>` and comments install instructions on the PR.
The dist-tag is removed and the versions deprecated automatically when the PR closes.

### Extension and VS Code (push to `main`)

- `extension/package.json#version` changed → `extension.yml` tags `ext-vX.Y.Z`, attaches the zip to a GitHub Release, and uploads to the Chrome Web Store with `--auto-publish` (`CWS_*` secrets in the `extension-release` environment; validate them anytime with the manual `cws-verify` dispatch job — it uploads a **draft** only).
- `vscode/package.json#version` changed → `vscode-release.yml` runs `vsce publish` (+ `ovsx publish` when `OVSX_PAT` is set), tags `vscode-vX.Y.Z`, attaches the `.vsix`. Needs `VSCE_PAT`.

### Manual npm publish — RECOVERY ONLY

Only if CI is down or a publish job is unrecoverable. Replicate the job's exact order:

```bash
git checkout main && git pull && npm ci
npm run build:gui
npm publish --workspace=@sfdt/flow-core --provenance --access public
npm publish --provenance --access public                      # @sfdt/cli
npm publish --workspace=@sfdt/plugin --provenance --access public
git tag vX.Y.Z && git push --tags
git tag -f v0 vX.Y.Z && git push -f origin v0                 # floating action tag
gh release create vX.Y.Z --generate-notes
```

Then bump the Homebrew tap manually (`shasum -a 256` of the npm tarball → update the tap repo)
and dispatch `docker-publish.yml` with the version. Prefer letting CI self-heal on the next
push to `main` over doing any of this by hand.

## 2. Pre-release gates

All on the release ref, before the release PR merges:

- [ ] `npm test` and `npm run lint` clean (root workspace covers CLI + flow-core + host; run `npm run test:all` when extension/vscode/plugin changed too).
- [ ] `npm run generate:catalogs` regenerated **from the release ref, AFTER the version bump** and committed. `generated/catalog-version.json` and `generated/packages.json` embed the package versions — bumping `package.json` without regenerating makes `check:catalogs` drift and fails the release CI. Run it as the last step before committing. The `generated/` catalogs (Commander command tree, Chrome features, GUI pages, MCP tools, parity matrix) are what the docs site and skills consume — never quote a hand-counted command number anywhere.
- [ ] `npm run check:all-contracts` clean — catalog drift + license-string + Node-version-claim + auth-docs consistency (also enforced in CI).
- [ ] **API-version registry current** — when Salesforce has shipped a new GA release since the last sfdt release, curate it in `src/lib/data/api-version-registry.json` (facts only from the official release notes; empty change lists are fine, wrong facts are not). `test/lib/api-version-registry.test.js` fails automatically when the registry falls behind the GA version.
- [ ] `npm run build:gui`, `npm run build:ext`, `npm run build:plugin` succeed.
- [ ] Version-bump commit includes a synced lockfile: `npm install --package-lock-only`, stage `package-lock.json` — or CI's `npm ci` fails on the release commit.
- [ ] `/pre-release-cli-test` run — smoke-tests `--help` for every registered command, derived from the Commander tree (never a hardcoded list or count).
- [ ] `/pre-release-security` run if anything outside docs/tests changed.
- [ ] `/pre-release-ui-test` run if anything in `gui/` changed.
- [ ] `/validate-npm-paths` run — package-internal paths must resolve via `import.meta.url`.
- [ ] `CHANGELOG.md` updated (Keep a Changelog format; move `[Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD`). If the bridge contract changed, call it out and reference the new `PROTOCOL_VERSION`.
- [ ] If `@modelcontextprotocol/sdk` was bumped past 1.29.x: manual smoke of `sf mcp start` (client side) and `sfdt mcp start` (server side) — at minimum `tools/list` plus one `tools/call` round-trip.

The skills are user-invoked — they are not auto-runnable from CI.

## 3. Branch mechanics: develop → main

Releases promote `develop` to `main` **wholesale** — CLI, flow-core, plugin, extension,
VS Code together. Never cut a side release branch and never cherry-pick a subset; both
re-drift the branches.

1. Land the version bump + CHANGELOG + lockfile sync on `develop` (normal PR).
2. Open the promote PR `develop → main`. Merge it as a **merge commit — never squash**. Squashing rewrites the commits, so `develop` and `main` permanently disagree and every later PR shows CONFLICTING.
3. Fast-forward `develop` back onto `main` so both sit at the same commit:

   ```bash
   git checkout develop && git pull
   git merge --ff-only origin/main && git push
   ```

4. Verify:

   ```bash
   git rev-list --left-right --count main...develop   # must print: 0	0
   ```

**The release is not done until that check reads 0/0.** In v0.17.0 the promote step was
skipped after the develop-side work merged; `main` sat 134 commits behind for a day while
the "released" code existed only on `develop`, and reconciling it afterwards took a
drift-repair merge. Treat the 0/0 check as a release gate, not housekeeping.

**Hotfixes:** a CLI hotfix that doesn't touch the bridge contract is a normal patch through
the same develop→main flow. One that does must also bump `PROTOCOL_VERSION` — and if the
bump is major, hold it until the extension side is ready (§6).

## 4. Docs site (sfdt.dev)

The public site lives in the separate `scoobydrew83/sfdt-site` repo. Cloudflare
**Workers Builds auto-deploys `master`** — the GitHub workflow there is a build check only,
so merging to `master` is deploying.

- [ ] Run `/sync-docs-site` — version references, install commands, changelog highlights, staleness pass over commands/flags/config keys/MCP tools.
- [ ] Its **Step 2b catalog sync**: regenerate `generated/` catalogs **from the released ref (never develop)**, then in sfdt-site run `node scripts/sync-upstream-catalogs.mjs` and `--check` to confirm clean. Site counts render from these files, never by hand.
- [ ] Merge any **HELD draft docs PRs** for features shipping in this release (e.g. the args-json Action docs). Drafts are held so the site never documents unreleased behavior; releasing is what un-holds them.
- [ ] Verify the deploy landed: check the Workers Builds run for `master` and spot-check a changed page on https://sfdt.dev/.

## 5. Per-surface release notes

### Chrome extension (`@sfdt/extension`)

- Bump `extension/package.json#version` through the develop→main flow; `extension.yml` handles the CWS upload (auto-publish) and the `ext-vX.Y.Z` tag.
- Web Store **review takes days** — plan protocol-affecting releases so the CLI that speaks the new protocol is on npm *before or as* the extension clears review. Note the minimum `@sfdt/cli` version in the CHANGELOG entry.
- Do a full doc-staleness sweep, not just the CHANGELOG: README feature claims (sourced from the catalogs), `extension/PRIVACY.md` permissions vs the manifest, store listing, screenshots.

### VS Code extension (`sfdt.sfdt-devtools`)

- Bump `vscode/package.json#version` + `vscode/CHANGELOG.md` (+ README if features/settings changed — the Marketplace re-renders it on publish).
- Verify locally: `npm run lint -w vscode && npm run test:vscode && npm run build:vscode && npm run package:vscode`.
- On merge to `main`, `vscode-release.yml` publishes to the Marketplace and Open VSX. Workspace selection is by **path** (`-w vscode`), never package name — the manifest name is unscoped. `VSCE_PAT` missing → manual `.vsix` upload at the publisher portal.

### sf plugin (`@sfdt/plugin`)

- Nothing to do — published by the same `ci.yml` job **after** the CLI.
- Its oclif commands are code-generated from `createCli()`; never hand-edit them. Its `@sfdt/cli` dep is `>=` (not pinned) so the bump commit's `npm ci` never 404s; the coupled publish means installs resolve to the matching version.

### flow-core / host

Nothing to do — flow-core is coupled to the CLI publish (and goes first); the host is bundled inside the CLI.

### First-release-only chores

- Make the GHCR package public (it's created private; `docker pull` 401s otherwise).
- Tick "Publish this Action to the GitHub Marketplace" on the Release once; it updates automatically afterwards.

## 6. Rollback playbook

npm versions are effectively immutable — **never unpublish** a release users may have
installed. Roll forward.

### npm published but docs/site failed or are stale

Do not touch npm. Fix the docs: re-run `/sync-docs-site`, merge to sfdt-site `master`,
verify the Workers Builds deploy. The package is fine; only the paper trail lagged.

### `@sfdt/cli` on npm but `@sfdt/flow-core` missing at the needed version

Should be impossible — the publish job orders flow-core first and fails the run otherwise.
If it somehow happens (e.g. a manual recovery publish done out of order): **stop everything**,
publish flow-core at the required version immediately, then verify
`npm install @sfdt/cli@X.Y.Z` resolves clean before doing anything else.

### Floating Action tag (`v0`) points at a broken release

```bash
git tag -f v0 vX.Y.(Z-1) && git push -f origin v0    # back to last-good
```

Leave the immutable `vX.Y.Z` tag alone. Ship a patch release; its publish job moves `v0`
forward again.

### Docs deployed claiming something stable that isn't

Revert or correct the sfdt-site page immediately (merging to `master` deploys). Then add
the offending phrase to the site's regression checks so the same claim can't ship silently
again.

### Protocol mismatch shipped

The CLI speaks a new major protocol; the store extension doesn't. Every user sees a
"major version mismatch" error until the extension clears review — this is the failure you
**prevent, not fix**: never merge a breaking-protocol CLI release until the matching
extension is through Web Store review. If it shipped anyway: patch the CLI to restore the
old protocol compatibility (roll forward) — don't wait days on the Store.

### Publish job failed mid-way

Nothing to unwind — every publish step is idempotent, and the version check compares against
npm's `latest`. Fix the cause, push to `main`, and the job self-heals on that run.

## 7. Post-release

- [ ] Run `/post-release` — archives `pr-analysis/` gate artifacts into `released/`, confirms branch sync, enumerates cleanup items.
- [ ] Verify every distribution channel:
  - `npm view @sfdt/cli version` (and `@sfdt/flow-core`, `@sfdt/plugin`) shows the new version.
  - GHCR image tag present; Homebrew tap formula bumped; GitHub Release exists.
  - `v0` moved (stable releases only).
  - Marketplace / Web Store versions live (for VS Code / extension releases).
- [ ] `git rev-list --left-right --count main...develop` → `0	0` (§3 — the release isn't done until it is).
- [ ] Docs-site staleness pass done and deployed (§4).

## What this document does NOT cover

- Day-to-day commit hygiene.
- The `/release` skill — it wraps the version bump, CHANGELOG, and release-PR steps above into one interactive workflow.
- Branch protection and CODEOWNERS — see `.github/CODEOWNERS`.
