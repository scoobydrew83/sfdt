# gh_code_search.py — Reference

Enhanced wrapper for `gh search code` with additional filtering, sorting, and output formatting.

---

## Prerequisites

- Python 3.8+
- GitHub CLI (`gh`) installed and authenticated

---

## Usage

```bash
python3 scripts/gh_code_search.py [OPTIONS] QUERY
```

---

## All Options

### Pass-through to `gh search code`

| Flag | Description |
|------|-------------|
| `-L, --limit N` | Max results (default: 30) |
| `--language LANG` | Filter by language (e.g. `python`, `typescript`) |
| `--filename NAME` | Filter by exact filename |
| `--extension EXT` | Filter by file extension (without dot) |
| `-R, --repo OWNER/NAME` | Filter by repository (repeatable) |
| `--owner OWNER` | Filter by owner/org (repeatable) |
| `--match file\|content` | Match in file path or file content only |
| `--size RANGE` | Filter by file size **in bytes** (e.g. `100..5000`, `>1000`) |

> **Note on `--size`:** GitHub code search sizes are in **bytes**, not KB.
> Use `100..5000` for files between 100 and 5000 bytes.

### Extra filters (applied after `gh` returns results)

| Flag | Description |
|------|-------------|
| `--exclude-forks` | Drop results from forked repos |
| `--exclude-private` | Drop results from private repos |
| `--min-matches N` | Only keep files with ≥ N text match fragments |

### Output & sorting

| Flag | Description |
|------|-------------|
| `-o, --output FORMAT` | `pretty` (default), `json`, `summary` |
| `--sort-by FIELD` | `matches`, `repo`, or `path` |

---

## Examples

```bash
# Search Python files for "hello world"
python3 scripts/gh_code_search.py "hello world" --language python

# Search a specific repo, pretty output
python3 scripts/gh_code_search.py "error handling" --repo microsoft/vscode

# Exclude forks, get summary stats
python3 scripts/gh_code_search.py "TODO" --extension md --exclude-forks --output summary

# Sort by match count, JSON output
python3 scripts/gh_code_search.py "class.*Component" --language typescript \
  --sort-by matches --output json

# Multiple repo owners
python3 scripts/gh_code_search.py "KONG_DNS" --owner twu556 --owner kong

# Files between 200 and 2000 bytes
python3 scripts/gh_code_search.py "config" --size "200..2000"
```

---

## Output Formats

**`pretty`** — Human-readable table with file path, URL, match count, and first fragment preview.

**`json`** — Full raw results array from `gh`, after filters and sorting applied.

**`summary`** — Aggregate statistics: total files, total match fragments, top repos, file extensions.

---

## Error Handling

| Error | Cause |
|-------|-------|
| `rate limit exceeded` | GitHub's 10 req/min search limit hit; wait 60s |
| `Search timed out` | Query too broad or GitHub-side timeout; simplify query |
| `gh command failed` | Auth expired or network issue; run `gh auth status` |

---

## Troubleshooting

**No results returned** — GitHub code search indexes public repos with some lag. Private repos require appropriate `gh` auth scopes.

**Rate limit on every run** — GitHub limits unauthenticated code search heavily. Ensure `gh` is authenticated with a token that has `repo` scope.
