# gh_failed_run.py — Reference

Analyzes the most recent failed GitHub Actions workflow run and returns structured JSON with run metadata and per-job error excerpts.

---

## Prerequisites

- Python 3.6+
- GitHub CLI (`gh`) installed and authenticated (`gh auth login`)

---

## Usage

```bash
python3 scripts/gh_failed_run.py [OPTIONS]
```

### Options

| Flag | Description |
|------|-------------|
| `--repo owner/name` | Target repository (default: current repo detected by gh) |
| `--pretty` | Pretty-print JSON output with indentation |

### Examples

```bash
# Analyze the current repository
python3 scripts/gh_failed_run.py --pretty

# Analyze a specific repository
python3 scripts/gh_failed_run.py --repo twu556/onboarding --pretty
```

---

## Output Format

```json
{
  "run": {
    "number": 42,
    "database_id": 123456789,
    "url": "https://github.com/owner/repo/actions/runs/123456789",
    "workflow": "CI",
    "conclusion": "failure",
    "status": "completed",
    "created_at": "2024-01-15T10:30:00Z",
    "branch": "main",
    "commit": "abc123...",
    "event": "push"
  },
  "failed_jobs": [
    {
      "name": "build",
      "database_id": 987654321,
      "conclusion": "failure",
      "status": "completed",
      "started_at": "2024-01-15T10:30:05Z",
      "completed_at": "2024-01-15T10:31:00Z",
      "error_excerpts": [
        "Error: Cannot find module './missing-file'",
        "Process completed with exit code 1"
      ]
    }
  ],
  "repository": "owner/repo"
}
```

---

## Notes

- **Job logs use numeric databaseId**, not display names — the script handles this automatically.
- Log fetches time out after 120s for large runs; a warning is printed and the job is included without excerpts.
- If no failed runs exist, the output is `{"error": "No failed runs found", "repository": "..."}`.
- Error excerpt extraction matches common patterns: `error`, `failed`, `exception`, `panic`, `timeout`, non-zero exit codes.

---

## Troubleshooting

**"gh CLI is not authenticated"** — Run `gh auth login` and complete the OAuth flow.

**Empty `error_excerpts`** — The job failed but logs contained no lines matching the error patterns (e.g. the failure was a signal/OOM kill). Check the run URL directly.

**Wrong run returned** — The script always picks the single most recent run with `conclusion=failure`. Pass `--repo` explicitly if gh is detecting the wrong working directory.
