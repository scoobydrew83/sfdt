---
name: gh-cli
description: >
  Use this skill for any GitHub CLI (gh) task. Trigger it whenever the user
  mentions: debugging a failed workflow or Action, why a CI run failed, deploying
  to GitHub Pages, searching GitHub code across repos, creating or merging PRs,
  managing issues or releases, running gh commands, or anything involving GitHub
  repos from the terminal. Also use for general gh best practices even when no
  specific script is needed.
compatibility:
  requires:
    - gh CLI (https://cli.github.com/) installed and authenticated via `gh auth login`
    - Python 3.8+ (for the bundled scripts)
---

# GitHub CLI (gh)

## Overview

Three bundled Python scripts cover the most common advanced `gh` workflows. For
everything else, the General Usage section below provides a quick command reference.

**Before running any script, verify auth:**
```bash
gh auth status
```

---

## Bundled Scripts

### 1. Enhanced Code Search — `scripts/gh_code_search.py`

Advanced `gh search code` wrapper with extra filtering, sorting, and output formats.

**Key additions over raw `gh`:** exclude forks/private repos, minimum match count filter, summary statistics output, sort by match count / repo / path.

**Quick start:**
```bash
python3 scripts/gh_code_search.py "KONG_DNS_RESOLVER" --owner twu556 --output pretty
python3 scripts/gh_code_search.py "TODO" --extension md --exclude-forks --output summary
```

**Full reference:** `references/README_gh_code_search.md`

---

### 2. Workflow Failure Analysis — `scripts/gh_failed_run.py`

Finds the most recent failed Actions run, fetches per-job logs using numeric job IDs,
and returns structured JSON with error excerpts.

**Quick start:**
```bash
python3 scripts/gh_failed_run.py --pretty
python3 scripts/gh_failed_run.py --repo twu556/onboarding --pretty
```

**Full reference:** `references/README_gh_failed_run.md`

---

### 3. GitHub Pages Management — `scripts/gh_pages_deploy.py`

Enable Pages, check status, trigger rebuilds, and generate starter workflow files.

**Quick start:**
```bash
python3 scripts/gh_pages_deploy.py enable twu556/onboarding
python3 scripts/gh_pages_deploy.py status twu556/onboarding --build-info
python3 scripts/gh_pages_deploy.py create-workflow
```

> **Security note:** `create-workflow --output PATH` only accepts paths inside the
> current working directory. Absolute paths that escape cwd are rejected.

**Full reference:** `references/README_pages.md`

---

## General GitHub CLI Reference

For common one-off tasks, reach for `gh` directly without any script.

### Pull Requests
```bash
gh pr list                          # List open PRs
gh pr create --title "…" --body "…" # Create PR (opens editor if flags omitted)
gh pr merge 42 --squash             # Merge PR #42 with squash
gh pr checkout 42                   # Check out PR branch locally
gh pr review 42 --approve           # Approve a PR
gh pr view 42 --web                 # Open PR in browser
```

### Issues
```bash
gh issue list --label bug           # Filter by label
gh issue create                     # Interactive issue creation
gh issue close 17 --comment "fixed" # Close with comment
```

### Workflow Runs
```bash
gh run list --limit 10              # Recent runs
gh run watch                        # Live-tail current run
gh run rerun 123456789 --failed-only # Re-run only failed jobs
gh run download 123456789           # Download run artifacts
```

### Releases
```bash
gh release list
gh release create v1.2.3 --generate-notes
gh release upload v1.2.3 dist/*.tar.gz
```

### Repos & Gists
```bash
gh repo view --web                  # Open repo in browser
gh repo clone owner/repo
gh gist create file.txt --public
```

### Extensions
```bash
gh extension list                   # Installed extensions
gh extension install github/gh-copilot
```

### Aliases (save repetitive commands)
```bash
gh alias set prs 'pr list --author @me'
gh prs
```

---

## Tips

- Use `gh <command> --help` for full flag reference on any subcommand.
- `gh api` gives direct REST access: `gh api /repos/twu556/onboarding/actions/runs`
- `gh api graphql -f query='…'` for GraphQL queries.
- All three bundled scripts accept `--help` for their own full flag reference.
