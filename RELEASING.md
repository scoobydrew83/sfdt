# Releasing sfdt

This monorepo contains five workspaces with different release cadences:

| Workspace | Distribution | Versioning | Cadence |
|---|---|---|---|
| `@sfdt/cli` | npm (`@sfdt/cli`); also drives the **Homebrew tap** and the **GHCR Docker image** | Independent semver | Whenever a meaningful CLI change lands. Most releases come from here. |
| `@sfdt/extension` | Chrome Web Store (zip from `npm run package:ext`) | Independent semver, tracked in `extension/package.json` | Reviewed by the Web Store — slower than CLI. Bump when Web Store-bound behavior changes, not for every CLI release. |
| `sfdt-devtools` (`/vscode`) | VS Code Marketplace as **`sfdt.sfdt-devtools`** (+ optional Open VSX) | Independent semver, tracked in `vscode/package.json` (tag `vscode-v*`) | Bump when the extension's behavior or its README/listing changes. Versions independently of the CLI. |
| `@sfdt/host` | Bundled inside `@sfdt/cli` (installed via `sfdt extension install-host`) | Lock-step with `@sfdt/cli` | Always shipped alongside the CLI. |
| `@sfdt/flow-core` | npm (`@sfdt/flow-core`), published by the CLI's `ci.yml` job as a coupled sub-step of a CLI release | Independent semver; CLI + extension depend on `^0.9.0` | When the **bridge contract** or **scoring rules** change. The contract changing is the load-bearing event. |

The release policy below codifies how those cadences interact.

---

## Wire-protocol version (`PROTOCOL_VERSION`)

This is the single most important versioning decision in the monorepo. It lives in [`packages/flow-core/src/bridge-contract.ts`](packages/flow-core/src/bridge-contract.ts) and is exchanged on `/api/bridge/ping`. The extension and CLI compare it via `negotiateProtocolVersion`:

- **Same major + same minor** → ok.
- **Same major + different minor** → warn (backward-compatible).
- **Different major** → refuse to talk.

### Bump rules

| Change | Bump |
|---|---|
| New `SfdtRequestKind` | MINOR (e.g. `1.1` → `1.2`) |
| New optional field on an existing response | MINOR |
| New error code | MINOR |
| Removed `SfdtRequestKind` | MAJOR (`1.x` → `2.0`) |
| Renamed required field | MAJOR |
| Changed field type | MAJOR |
| Removed legacy fallback (e.g. `flowId` → `flowApiName`) | MAJOR |

A protocol bump is **separate from** the CLI / extension / flow-core release version. Patch-level CLI releases don't touch it; a major contract break is rare.

When you bump the protocol:
1. Edit `PROTOCOL_VERSION` in `bridge-contract.ts`.
2. Add a line to the bump-changelog comment block in that file.
3. Update tests in `test/lib/bridge-routes.test.js`, `extension/test/sfdt-bridge.test.ts`, and `packages/flow-core/test/protocol-version.test.ts`.
4. Rebuild flow-core: `npm run build:flow-core`.

---

## Release flows by workspace

### Releasing `@sfdt/cli` (the common case)

1. **Pre-flight.**
   ```bash
   git checkout main && git pull
   npm install
   npm test               # 100+ test files, 1500+ tests across all workspaces
   npm run lint
   npm run build:flow-core
   npm run build:gui
   npm run build:ext      # not published, but verifies the monorepo still builds
   ```

2. **Bump the version.** Edit `package.json#version`. Follow semver against the CLI's user-facing surface (commands, flags, output format), not the internals.

3. **Update `CHANGELOG.md`.** Use the existing format. If the bridge contract changed, call that out explicitly and reference the new `PROTOCOL_VERSION`. If extension Web Store behavior also needs to change, note it under "Extension impact" and **link to the extension release PR**.

4. **Open and merge the release PR.** Squash. Title: `release: vX.Y.Z`.

5. **Publish.** From `main` after the merge:
   ```bash
   npm run build:gui       # also runs via `prepack`
   npm publish --access public
   git tag vX.Y.Z && git push --tags
   gh release create vX.Y.Z --notes-file <(awk '/^## \[X.Y.Z\]/,/^## \[/' CHANGELOG.md | head -n -1)
   ```

6. **Post-release.** Run the `/post-release` skill (it archives `pr-analysis/` artifacts, confirms `main` / `develop` sync, and enumerates cleanup items).

7. **Distribution channels (ride the CLI version bump).** A CLI release also feeds two channels off the same version — handle them after npm publish:
   - **Docker / GHCR (automatic).** The `publish` job's downstream `docker` job calls the reusable `docker-publish.yml` in the **same** CI run, building the multi-arch image and pushing `ghcr.io/scoobydrew83/sfdt:X.Y.Z` + `:latest`. (It does **not** rely on the `release: published` event — a Release created by `GITHUB_TOKEN` doesn't fire downstream workflows, which is why the call is wired directly.) To (re)publish a specific version on demand — e.g. after a Dockerfile fix that didn't ride a version bump — run `docker-publish.yml` via **workflow_dispatch** with the version input (builds from `main`). Verify with `gh run list --workflow=docker-publish.yml`. **First release only:** make the GHCR package **public** (it's created private), or `docker pull` 401s.
   - **Homebrew (automatic when `HOMEBREW_TAP_TOKEN` is set).** The `publish` job's "Bump Homebrew tap" step computes the tarball `sha256` and pushes the new `url` + `sha256` to the tap repo `scoobydrew83/homebrew-sfdt` (`Formula/sfdt.rb`). This needs a **fine-grained PAT** (`contents:write` on the tap repo only) stored as the `HOMEBREW_TAP_TOKEN` secret — the default `GITHUB_TOKEN` can't write to another repo. If the secret is absent, the step logs a skip and you bump it manually:
     ```bash
     VERSION=X.Y.Z
     curl -fsSL "https://registry.npmjs.org/@sfdt/cli/-/cli-${VERSION}.tgz" | shasum -a 256
     # Update url + sha256 in the TAP repo's Formula/sfdt.rb, commit, push.
     ```
     The **tap repo is the single source of truth** for the formula — treat it as a publish target like npm/GHCR, not a parallel project. (The tap must be a separate `homebrew-*` repo; that's Homebrew's requirement for the `brew tap scoobydrew83/sfdt` UX, not something to "fix" by folding it into this repo.) The in-repo `Formula/sfdt.rb` mirror is **redundant** — it can't carry a correct `sha256` until after publish — and is slated for removal; do not spend effort keeping it in sync.
   - **GitHub Action (automatic).** The root `action.yml` makes this repo a composite action; the `publish` job's "Update floating major tag" step force-moves `v<major>` (`v0` today) to the release tag, so `uses: scoobydrew83/sfdt@v0` always resolves to the newest stable release (beta publishes never move it). Nothing to do per release. **First release with `action.yml` only:** list the action on the GitHub Marketplace manually — open the Release in the web UI, edit it, and tick **"Publish this Action to the GitHub Marketplace"** (requires the root `action.yml` with `branding:`; the listing then updates automatically on subsequent releases).

> **Note:** publish itself is CI-driven now — `.github/workflows/ci.yml` publishes `@sfdt/flow-core` then `@sfdt/cli` (with `--provenance`) on a version-bump push to `main`, and the beta channel publishes from `develop` on a pre-release version. The manual `npm publish` in step 5 is the fallback, not the normal path.

### Releasing the VS Code extension (`sfdt.sfdt-devtools`)

The VS Code extension lives in `vscode/` (manifest package name **`sfdt-devtools`** — unscoped, because the Marketplace rejects scoped names) and is published to the VS Code Marketplace as **`sfdt.sfdt-devtools`** ("SFDT for Salesforce", publisher `sfdt`). It versions independently of the CLI.

1. Bump `vscode/package.json#version` and add a `## [X.Y.Z] - YYYY-MM-DD` block to `vscode/CHANGELOG.md`. Update `vscode/README.md` if features/settings changed (the Marketplace re-renders it on publish).
2. Verify + package locally:
   ```bash
   npm run lint -w vscode && npm run test:vscode && npm run build:vscode
   npm run package:vscode      # -> vscode/sfdt-devtools-<version>.vsix
   ```
3. Open a PR to `main` (stage only `vscode/package.json`, `vscode/CHANGELOG.md`, and `vscode/README.md` if changed). On merge, `.github/workflows/vscode-release.yml` runs `vsce publish` (and `ovsx publish` if `OVSX_PAT` is set), tags `vscode-v{version}`, and attaches the `.vsix` to a GitHub Release.
4. **Required secret:** `VSCE_PAT` (Azure DevOps PAT, scope Marketplace → Manage). Without it the publish step fails — fall back to a manual `.vsix` upload at <https://marketplace.visualstudio.com/manage/publishers/sfdt>. `OVSX_PAT` (Open VSX) is optional.

> The extension bundles `@sfdt/flow-core` via esbuild (`--no-dependencies` at package time), so it never publishes flow-core to npm. Workspace selection uses the **path** form (`-w vscode`), never the package name.

### Releasing `@sfdt/extension`

The Web Store re-review process is slower than npm publish, so we bump the extension on a separate schedule. The extension's version is in `extension/package.json` and **does not need to match the CLI**.

1. Make sure the bridge `PROTOCOL_VERSION` you target is the one published to npm. If it isn't yet, ship a CLI release first or hold the extension release.
2. Bump `extension/package.json#version`.
3. Add an entry to `CHANGELOG.md` under an `## Extension X.Y.Z — YYYY-MM-DD` heading. Note the minimum `@sfdt/cli` version required (i.e. the one that ships the protocol version this extension expects).
4. `npm run package:ext` produces `extension/.output/<browser>-mv3.zip`.
5. Upload to the Chrome Web Store dashboard. The listing references this README + `extension/PRIVACY.md` for reviewers.
6. After the Store accepts the new version, tag: `git tag extension-vX.Y.Z && git push --tags`.

### Releasing `@sfdt/flow-core`

Flow-core is **public on npm** and publishes as a coupled sub-step of every CLI release — the
`ci.yml` publish job publishes it **before** `@sfdt/cli` (the CLI's dependency must resolve
first). It has no standalone release trigger; its version bumps with the CLI's release commit.

### Releasing `@sfdt/host`

The native messaging host has no independent release. It rides along inside `@sfdt/cli` and is installed at the user's machine via `sfdt extension install-host`. Its version equals the CLI version that shipped it.

---

## Gates that must pass

Before any release PR is merged:

- [ ] `npm test` clean (CLI + extension + flow-core + host + gui via the root workspace config).
- [ ] `npm run lint` clean.
- [ ] `npm run build:gui` and `npm run build:ext` both succeed.
- [ ] If anything in `packages/flow-core/src/bridge-contract.ts` changed, the `/pre-release-cli-test` skill has been run (verifies every registered CLI command's `--help` smoke — the list is derived from the Commander tree, never hardcoded).
- [ ] If anything in `gui/` changed, the `/pre-release-ui-test` skill has been run.
- [ ] If you're releasing the VS Code extension, `npm run test:vscode` + `npm run build:vscode` pass, the `.vsix` packages cleanly, and the `VSCE_PAT` secret is configured (or you'll upload the `.vsix` manually).
- [ ] After a CLI release: verify the CI `docker` job pushed the GHCR image (public on first release), and the "Bump Homebrew tap" step updated the tap's `Formula/sfdt.rb` (requires the `HOMEBREW_TAP_TOKEN` secret — bump manually if it skipped).
- [ ] If anything outside docs/tests changed, the `/pre-release-security` skill has been run.
- [ ] If `@modelcontextprotocol/sdk` was bumped past 1.29.x, a manual smoke test has been run against both `sf mcp start` (client side, `src/lib/mcp-client.js`) and `sfdt mcp start` (server side) — at minimum a `tools/list` plus one `tools/call` round-trip. The server relies on verified-but-undocumented SDK behaviors (handler results passed through verbatim, loose `_meta` parsing), so SDK bumps must not land silently.
- [ ] `CHANGELOG.md` updated.

The user invokes those skills (`/pre-release-cli-test`, `/pre-release-ui-test`, `/pre-release-security`) — they are not auto-runnable from CI.

---

## Hotfixes

A CLI hotfix that does **not** touch the bridge contract is a normal patch release: bump `package.json#version` to `X.Y.(Z+1)`, single-commit fix, ship.

A CLI hotfix that **does** touch the bridge contract must also bump `PROTOCOL_VERSION`. If the change is breaking (major bump), the in-flight extension release must be paused — shipping a CLI on protocol 2.0 while extensions on protocol 1.x are still in the Web Store will cause every user to see a "major version mismatch" error until the extension catches up.

---

## What this document does NOT cover

- Day-to-day commit hygiene (covered by the `/codex:setup` and `/git-workflow-master` skills).
- The actual `/release` skill — that wraps steps 2–5 of the CLI release flow above into one interactive workflow.
- Branch protection and CODEOWNERS — see `.github/CODEOWNERS`.
