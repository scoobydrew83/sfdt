# gh_pages_deploy.py — Reference

Automates GitHub Pages configuration and deployment via `gh api` calls. Four subcommands cover the full Pages lifecycle.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Commands](#commands)
   - [enable](#enable)
   - [status](#status)
   - [rebuild](#rebuild)
   - [create-workflow](#create-workflow)
3. [Workflow Template Notes](#workflow-template-notes)
4. [API Permissions](#api-permissions)
5. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- Python 3.6+
- GitHub CLI (`gh`) installed and authenticated (`gh auth login`)
- Appropriate repository permissions (admin access required for enabling Pages)

---

## Commands

### `enable`

Enable GitHub Pages for a repository.

```bash
python3 scripts/gh_pages_deploy.py enable <owner>/<repo> [OPTIONS]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--branch NAME` | `main` | Source branch |
| `--path /\|/docs` | `/` | Source directory |
| `--build-type workflow\|legacy` | `workflow` | GitHub Actions or Jekyll |
| `--no-https` | (off) | Disable HTTPS enforcement |

**Examples:**
```bash
# Enable with GitHub Actions (recommended)
python3 scripts/gh_pages_deploy.py enable twu556/onboarding

# Enable from /docs on a specific branch
python3 scripts/gh_pages_deploy.py enable twu556/docs --branch gh-pages --path /docs

# Enable with legacy Jekyll build
python3 scripts/gh_pages_deploy.py enable twu556/site --build-type legacy
```

---

### `status`

Check whether Pages is enabled and show current configuration.

```bash
python3 scripts/gh_pages_deploy.py status <owner>/<repo> [--build-info]
```

`--build-info` additionally fetches the latest build status (useful for debugging deployment failures).

```bash
python3 scripts/gh_pages_deploy.py status twu556/onboarding --build-info
```

---

### `rebuild`

Trigger a new Pages build without pushing a commit. Useful for recovering from transient build failures.

```bash
python3 scripts/gh_pages_deploy.py rebuild <owner>/<repo>
```

> Note: Only applicable to **legacy** (Jekyll) builds. GitHub Actions-based Pages deploy via workflow runs, not the rebuild API.

---

### `create-workflow`

Generate a starter GitHub Actions workflow file for Pages deployment.

```bash
python3 scripts/gh_pages_deploy.py create-workflow [--output PATH]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--output PATH` | `.github/workflows/pages.yml` | Output path (must be relative or inside cwd) |

**Safety:** Absolute paths that escape the current working directory are rejected. This prevents accidental overwrites of system files.

```bash
# Default location
python3 scripts/gh_pages_deploy.py create-workflow

# Custom location (relative path only)
python3 scripts/gh_pages_deploy.py create-workflow --output deploy/pages.yml
```

---

## Workflow Template Notes

The generated workflow intentionally **fails on first run** until you replace the placeholder build step. This is by design — a generic `cp -r *` would copy secrets, node_modules, and other sensitive files into your Pages artifact.

**Customize the build step for your framework:**

```yaml
# Next.js
- run: npm ci && npm run build && cp -r out _site

# Hugo
- run: hugo --minify --destination _site

# Plain HTML (from a specific directory)
- run: mkdir -p _site && cp -r public/* _site/

# Jekyll (use the jekyll build action instead)
- uses: actions/jekyll-build-pages@v1
  with:
    source: ./
    destination: ./_site
```

After customizing, remove the `exit 1` guard line in the template.

---

## API Permissions

The GitHub token used by `gh` needs:

| Operation | Required Permission |
|-----------|---------------------|
| `enable` | Admin — repository settings |
| `status` | Read — repository |
| `rebuild` | Write — pages |
| `create-workflow` | Write — contents (to push the file) |

For organization repos, a fine-grained PAT or OAuth app with `pages` and `administration` scopes may be required.

---

## Troubleshooting

**"GitHub CLI is not authenticated"** — Run `gh auth login`. For org repos, ensure your token has `repo` scope.

**422 on enable** — Pages is already enabled. Use `status` to inspect current config or update via repo Settings > Pages.

**rebuild has no effect** — If your repo uses GitHub Actions for Pages (build-type: workflow), rebuilds must be triggered via `gh run` or a new commit, not via the Pages rebuild API.

**create-workflow writes to wrong place** — Always run the script from the root of your repository clone so the default `.github/workflows/pages.yml` lands in the right place.
