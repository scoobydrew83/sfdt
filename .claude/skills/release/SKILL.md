---
name: release
description: Prepare and publish a new sfdt CLI release. Handles version bumping (asks user for patch/minor/major), writing the CHANGELOG entry from git history, updating README and usage docs, then creating a GitHub PR. Use when the user says "release", "publish", "bump version", "cut a release", or "ship this".
---

# sfdt Release Skill

Guides a full release cycle for `@sfdt/cli`: version bump → changelog → docs update → GitHub PR.

## Step 1: Determine the version bump

1. Run `git log $(git describe --tags --abbrev=0)..HEAD --oneline` to list commits since last tag.
2. Show the commit list to the user.
3. **Ask the user**: "What type of version bump? `patch` (bug fixes), `minor` (new features), or `major` (breaking changes)?"
   - Do NOT guess or proceed without an answer.
4. Read the current version from `package.json`.
5. Calculate the new version string (e.g. `0.3.1` → `0.3.2` for patch).

## Step 2: Update CHANGELOG.md

1. Read `CHANGELOG.md` and the commit list gathered in Step 1.
2. Categorize each commit under the appropriate Keep a Changelog headers:
   - `### Added` — new features, new commands, new config keys
   - `### Changed` — behavior changes, updates to existing commands
   - `### Fixed` — bug fixes
   - `### Security` — security fixes
   - `### Removed` — removed features
   - `### Deprecated` — deprecation notices
3. Write a new release block above the existing `## [Unreleased]` line:
   ```markdown
   ## [X.Y.Z] - YYYY-MM-DD
   ```
   Use today's date from the environment context (not from memory or training data).
4. Empty the `## [Unreleased]` section (keep the header).
5. Entries must be user-facing and descriptive — not raw commit messages. Expand terse commits into clear benefit statements.

## Step 3: Bump the version

1. Edit `package.json` — update the `"version"` field to the new version string.
2. Do NOT run `npm version` (it creates a git tag automatically, which is premature).

## Step 4: Update README.md

1. Read `README.md`.
2. Identify any new commands added since the last release by checking git diff of `src/commands/`.
3. For each new command:
   - Add a row to the command reference table (if one exists).
   - Add a usage example in the appropriate section, or create a new section.
4. Update the version badge or install instructions if they reference a specific version.
5. Only touch sections directly affected by the new release — do NOT rewrite unrelated content.

## Step 5: Update usage docs (if any)

1. Check `docs/` for relevant documentation files.
2. For any new commands or changed behavior, update or add docs entries.
3. Keep the same format and tone as existing docs.

## Step 6: Verify the changes

Before creating the PR:

1. Run `npm test` to confirm tests pass.
2. Run `npm run lint` to confirm no lint errors.
3. Show the user a summary:
   - New version number
   - Files changed
   - CHANGELOG preview (new release block)
4. Ask: "Ready to create the PR?" — do NOT proceed without confirmation.

## Step 7: Create the GitHub PR

1. Build the exact staging list from only the files modified in Steps 2–5:
   - `package.json` — always (version bump)
   - `CHANGELOG.md` — always
   - `README.md` — only if modified in Step 4
   - Individual docs files actually edited in Step 5 — by name, never `docs/` wholesale
   - **Never** stage `docs/superpowers/` or any planning/tooling artifacts

2. Show the user the exact file list and ask for confirmation before staging.

3. Stage and commit only those files:
   ```bash
   git add package.json CHANGELOG.md          # always
   git add README.md                          # if modified
   git add docs/ARCHITECTURE.md              # example: only specific docs files
   git commit -m "chore: release v{version}"
   ```

4. Push the branch:
   ```bash
   git push -u origin HEAD
   ```

5. Create a PR targeting `main` using `gh pr create`:
   ```bash
   gh pr create \
     --title "chore: release v{version}" \
     --body "$(cat <<'EOF'
   ## Release v{version}

   {full CHANGELOG block for this release}

   ## Test checklist
   - [ ] `npm test` passes
   - [ ] `npm run lint` passes
   - [ ] Install from npm and run `sfdt --version` confirms new version
   EOF
   )"
   ```

6. Return the PR URL to the user.

## Rules

- NEVER bump the version without asking the user first.
- NEVER use `npm version` — it creates tags prematurely.
- NEVER push directly to `main`.
- NEVER skip the test/lint check before creating the PR.
- Always use today's date from the environment (never from memory or training data) for CHANGELOG entries.
- If any step produces errors, stop and report to the user before continuing.
- Only modify files directly related to the release — no opportunistic refactoring.
