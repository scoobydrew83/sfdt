# Publishing the SFDT Skills Pack

How to distribute the bundled agent skills (`skills/`) beyond the npm package,
plus the checklist of items each publishing channel needs. Follows the
2026-07-12 skills audit (`docs/skills-audit-2026-07-12.md`).

## What already ships

- **npm**: `skills/` is in `package.json` `files`, so every `@sfdt/cli` install
  carries the skills. Users materialize them with `sfdt skills export`.
- **`sfdt skills export --target claude`**: installs the skills natively into
  the target project as `.claude/skills/<name>/` folders (Claude Code's real
  project-skill convention — name + description frontmatter drive triggering).
  Legacy `.clauderules` / `.claudecode.json` are still written for older tooling.
- **`--target cursor|codex|windsurf`**: flattened rules files.
- **`--target pack`**: an `npx skills add`-compatible pack (`manifest.json` +
  `skills/` folders, same layout as `forcedotcom/sf-skills`).

Eval prompt seeds (`skills/<name>/evals/evals.json`) are authoring assets: they
are committed to git and ship in the npm tarball, but are **filtered out of
every export** (pack manifests, pack copies, and `.claude/skills` installs).

## Channel 1 — a standalone skills repo (`npx skills add`)

`npx skills add <github-slug>` resolves `manifest.json` + `skills/` at the
**repo root** of a published GitHub repo. This monorepo's root is the CLI
package, so the pack must live in a dedicated repo (e.g.
`scoobydrew83/sfdt-skills`), regenerated on each release:

```bash
sfdt skills export --target pack --out ../sfdt-skills
cd ../sfdt-skills && git add -A && git commit -m "Sync skills from @sfdt/cli vX.Y.Z" && git push
```

To automate: add a release-job step in `ci.yml` that runs the export and pushes
to the skills repo with a deploy token. Users then install with:

```bash
npx skills add scoobydrew83/sfdt-skills          # all skills
npx skills add scoobydrew83/sfdt-skills --skill sf-apex-review
```

## Channel 2 — claude.ai skills library (`.skill` files)

claude.ai accepts uploaded `.skill` bundles (a zip of the skill folder,
`SKILL.md` first). Each skill folder here is already structurally valid:
frontmatter carries `name`, `description`, and `license`, and bundled
resources live under `references/`. To package one:

```bash
cd skills && zip -r ../sf-apex-review.skill sf-apex-review -x "*/evals/*"
```

(or use Anthropic's skill-creator `package_skill.py` if available). Upload via
claude.ai → Settings → Capabilities → Skills. Org admins can distribute to a
whole workspace.

## Channel 3 — the docs site (sfdt.dev)

The skills pack should have its own page on https://sfdt.dev/. A ready-to-use
MDX draft is at `docs/sfdt-site-drafts/skills.mdx` — copy it into the
`sfdt-site` repo under `content/` (add a `_meta.js` entry) the next time that
repo is touched. Until that page exists, the pack is undiscoverable outside
the CLI's help output.

## Per-skill metadata checklist (before publishing to any library)

All items below are enforced by `test/commands/skills-content.test.js`:

- [x] `name` frontmatter matches the folder name (registries key installs off it)
- [x] `description` present, ≤ 1024 chars, states what the skill does **and**
      when to use it (skills under-trigger; be assertive)
- [x] `license: Apache-2.0` frontmatter (registries and marketplaces require it)
- [x] Eval seeds committed (`evals/evals.json`, ≥ 2 realistic prompts) so any
      future revision can be benchmarked with skill-creator
- [x] `sfdt-cli` documents every registered CLI command (drift guard)

Not enforced, check manually per release:

- [ ] Version-sensitive content still true (Code Analyzer v5 flags, sf CLI
      command names, Salesforce release-gated features like `sf logic run test`)
- [ ] No project-specific values (org aliases, ticket numbers, coverage targets)
- [ ] Regenerate + push the standalone skills repo (Channel 1)
- [ ] Re-package any `.skill` uploads whose source changed (Channel 2)

## Benchmarking skill revisions (skill-creator loop)

The committed eval seeds are the input to the skill-creator improvement loop.
To benchmark a revision locally:

1. Snapshot the current skill (`cp -r skills/<name> skills/<name>-workspace/skill-snapshot`)
2. For each prompt in `skills/<name>/evals/evals.json`, run the task once with
   the revised skill and once with the snapshot (subagents if available)
3. Compare against `expected_output`; keep the revision only if it wins

Workspaces (`skills/*-workspace/`) and any eval outputs are gitignored — only
the `evals.json` seeds are tracked.
