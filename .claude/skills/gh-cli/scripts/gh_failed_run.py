#!/usr/bin/env python3
"""
GitHub Actions Failed Run Analyzer

This script finds the most recent failed GitHub Actions run and provides
detailed information about what went wrong, including error excerpts from logs.
"""

import argparse
import json
import subprocess
import sys
import re
from typing import Optional, Dict, List, Any


class GHCommandError(Exception):
    """Raised when a gh CLI command fails."""
    pass


def run_gh_command(cmd: List[str], timeout: int = 60) -> Any:
    """
    Execute a gh CLI command and return parsed JSON output.

    Args:
        cmd: List of command arguments to pass to gh
        timeout: Seconds before the command is killed (default: 60)

    Returns:
        Parsed JSON output from the command

    Raises:
        GHCommandError: If gh command fails or times out
    """
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True,
            timeout=timeout
        )
        return json.loads(result.stdout) if result.stdout else {}
    except subprocess.TimeoutExpired:
        raise GHCommandError(
            f"gh command timed out after {timeout}s: {' '.join(cmd)}"
        )
    except subprocess.CalledProcessError as e:
        raise GHCommandError(
            f"gh command failed: {' '.join(cmd)}\n{e.stderr.strip()}"
        )
    except json.JSONDecodeError as e:
        raise GHCommandError(
            f"Failed to parse JSON output from gh command: {e}"
        )


def get_most_recent_failed_run(repo: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Get the most recent failed workflow run."""
    cmd = [
        "gh", "run", "list",
        "--status", "failure",
        "--limit", "1",
        "--json", "databaseId,number,conclusion,status,createdAt,displayTitle,url,headBranch,headSha,event"
    ]
    if repo:
        cmd.extend(["--repo", repo])
    runs = run_gh_command(cmd)
    return runs[0] if runs else None


def get_failed_jobs(run_id: int, repo: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Get all jobs from a run and filter for failed ones.
    Each returned job dict includes databaseId for log fetching.
    """
    cmd = ["gh", "run", "view", str(run_id), "--json", "jobs"]
    if repo:
        cmd.extend(["--repo", repo])
    result = run_gh_command(cmd)
    jobs = result.get("jobs", [])
    return [
        job for job in jobs
        if job.get("conclusion") not in ["success", "skipped", None]
    ]


def extract_error_excerpts(log_text: str, max_lines: int = 50) -> List[str]:
    """Extract relevant error lines from log text."""
    error_patterns = [
        r".*\berror\b.*",
        r".*\bfailed\b.*",
        r".*\bfailure\b.*",
        r".*\bexception\b.*",
        r".*\bERROR\b.*",
        r".*\bFAILED\b.*",
        r".*\bFAILURE\b.*",
        r".*\bEXCEPTION\b.*",
        r".*\bcannot\b.*",
        r".*\bpanic\b.*",
        r".*Process completed with exit code [1-9].*",
        r".*\btimeout\b.*",
    ]

    excerpts = []
    for line in log_text.split('\n'):
        line = line.strip()
        if not line:
            continue
        for pattern in error_patterns:
            if re.search(pattern, line, re.IGNORECASE):
                clean = re.sub(r'\x1b\[[0-9;]*m', '', line)
                clean = re.sub(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*', '', clean)
                if clean and clean not in excerpts:
                    excerpts.append(clean)
                    if len(excerpts) >= max_lines:
                        return excerpts
                break
    return excerpts


def get_job_logs(run_id: int, job_id: int, repo: Optional[str] = None) -> str:
    """
    Get logs for a specific failed job using its numeric databaseId.

    NOTE: gh run view --job requires a numeric job databaseId, NOT the display name.
    """
    cmd = [
        "gh", "run", "view", str(run_id),
        "--log-failed",
        "--job", str(job_id)
    ]
    if repo:
        cmd.extend(["--repo", repo])

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=True, timeout=120
        )
        return result.stdout
    except subprocess.TimeoutExpired:
        print(f"Warning: log fetch timed out for job {job_id}", file=sys.stderr)
        return ""
    except subprocess.CalledProcessError:
        # Fall back to all failed logs for the run
        fallback = ["gh", "run", "view", str(run_id), "--log-failed"]
        if repo:
            fallback.extend(["--repo", repo])
        try:
            result = subprocess.run(
                fallback, capture_output=True, text=True, check=True, timeout=120
            )
            return result.stdout
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            return ""


def analyze_failed_run(repo: Optional[str] = None) -> Dict[str, Any]:
    """Analyze the most recent failed run and extract all relevant information."""
    run = get_most_recent_failed_run(repo)
    if not run:
        return {"error": "No failed runs found", "repository": repo or "current"}

    failed_jobs = get_failed_jobs(run["databaseId"], repo)

    result = {
        "run": {
            "number": run["number"],
            "database_id": run["databaseId"],
            "url": run["url"],
            "workflow": run["displayTitle"],
            "conclusion": run["conclusion"],
            "status": run["status"],
            "created_at": run["createdAt"],
            "branch": run.get("headBranch"),
            "commit": run.get("headSha"),
            "event": run.get("event")
        },
        "failed_jobs": [],
        "repository": repo or "current"
    }

    for job in failed_jobs:
        job_database_id = job.get("databaseId")
        job_info = {
            "name": job["name"],
            "database_id": job_database_id,
            "conclusion": job["conclusion"],
            "status": job.get("status"),
            "started_at": job.get("startedAt"),
            "completed_at": job.get("completedAt"),
            "error_excerpts": []
        }
        if job_database_id:
            logs = get_job_logs(run["databaseId"], job_database_id, repo)
            if logs:
                job_info["error_excerpts"] = extract_error_excerpts(logs)
        result["failed_jobs"].append(job_info)

    return result


def main():
    """Main entry point for the script."""
    parser = argparse.ArgumentParser(
        description="Analyze the most recent failed GitHub Actions run",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s                        # Analyze current repository
  %(prog)s --repo owner/name      # Analyze specific repository
        """
    )
    parser.add_argument("--repo", type=str, help="Repository in format 'owner/name'")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    args = parser.parse_args()

    # Verify gh CLI is installed and authenticated
    try:
        subprocess.run(
            ["gh", "auth", "status"], capture_output=True, check=True, timeout=15
        )
    except subprocess.TimeoutExpired:
        print("Error: gh auth check timed out", file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError:
        print("Error: gh CLI is not authenticated. Run 'gh auth login'.", file=sys.stderr)
        sys.exit(1)
    except FileNotFoundError:
        print("Error: gh CLI is not installed or not in PATH", file=sys.stderr)
        print("Install from: https://cli.github.com/", file=sys.stderr)
        sys.exit(1)

    try:
        result = analyze_failed_run(args.repo)
    except GHCommandError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(result, indent=2 if args.pretty else None))


if __name__ == "__main__":
    main()
