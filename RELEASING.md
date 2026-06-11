# Releasing sfdt

This monorepo ships from `feature/flow-toolkit-monorepo` (today) and from `main` (once landed). It contains four workspaces with different release cadences:

| Workspace | Distribution | Versioning | Cadence |
|---|---|---|---|
| `@sfdt/cli` | npm (`@sfdt/cli`) | Independent semver | Whenever a meaningful CLI change lands. Most releases come from here. |
| `@sfdt/extension` | Chrome Web Store (zip from `npm run package:ext`) | Independent semver, tracked in `extension/package.json` | Reviewed by the Web Store — slower than CLI. Bump when Web Store-bound behavior changes, not for every CLI release. |
| `@sfdt/host` | Bundled inside `@sfdt/cli` (installed via `sfdt extension install-host`) | Lock-step with `@sfdt/cli` | Always shipped alongside the CLI. |
| `@sfdt/flow-core` | Workspace-only today; **future**: npm `@sfdt/flow-core` | Independent semver once published; today consumed via workspace `*` | When the **bridge contract** or **scoring rules** change. The contract changing is the load-bearing event. |

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

### Releasing `@sfdt/extension`

The Web Store re-review process is slower than npm publish, so we bump the extension on a separate schedule. The extension's version is in `extension/package.json` and **does not need to match the CLI**.

1. Make sure the bridge `PROTOCOL_VERSION` you target is the one published to npm. If it isn't yet, ship a CLI release first or hold the extension release.
2. Bump `extension/package.json#version`.
3. Add an entry to `CHANGELOG.md` under an `## Extension X.Y.Z — YYYY-MM-DD` heading. Note the minimum `@sfdt/cli` version required (i.e. the one that ships the protocol version this extension expects).
4. `npm run package:ext` produces `extension/.output/<browser>-mv3.zip`.
5. Upload to the Chrome Web Store dashboard. The listing references this README + `extension/PRIVACY.md` for reviewers.
6. After the Store accepts the new version, tag: `git tag extension-vX.Y.Z && git push --tags`.

### Releasing `@sfdt/flow-core` (when we publish it)

Flow-core is currently `"private": true` and consumed only as a workspace dependency. When we publish:

1. Remove `"private": true` from `packages/flow-core/package.json`.
2. Set `version` to `0.x.0` for the first publish; track its own changelog under `packages/flow-core/CHANGELOG.md`.
3. Publish from `main`:
   ```bash
   cd packages/flow-core
   npm publish --access public
   ```
4. Update root `package.json` (and `extension/package.json`) to depend on the published version instead of workspace `*` **only** when we have an external consumer — until then, workspace `*` is fine.

The trigger for publishing flow-core is "a second consumer appears" — a Firefox build, a VS Code extension, an MCP server wrapper, or someone outside this repo wanting to build on the scoring engine.

### Releasing `@sfdt/host`

The native messaging host has no independent release. It rides along inside `@sfdt/cli` and is installed at the user's machine via `sfdt extension install-host`. Its version equals the CLI version that shipped it.

---

## Gates that must pass

Before any release PR is merged:

- [ ] `npm test` clean (CLI + extension + flow-core + host + gui via the root workspace config).
- [ ] `npm run lint` clean.
- [ ] `npm run build:gui` and `npm run build:ext` both succeed.
- [ ] If anything in `packages/flow-core/src/bridge-contract.ts` changed, the `/pre-release-cli-test` skill has been run (verifies all 21 CLI commands' `--help` smoke).
- [ ] If anything in `gui/` changed, the `/pre-release-ui-test` skill has been run.
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
