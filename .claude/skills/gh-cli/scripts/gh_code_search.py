#!/usr/bin/env python3
"""
Python wrapper for 'gh search code' with filtering and formatting capabilities.

Provides enhanced search functionality with custom filters and multiple output formats.
"""

import argparse
import json
import subprocess
import sys
from typing import List, Dict, Any, Optional


class GHSearchError(Exception):
    """Custom exception for gh search errors."""
    pass


def build_gh_command(args: argparse.Namespace) -> List[str]:
    """Build the gh search code command from parsed arguments."""
    cmd = ["gh", "search", "code", args.query]

    if args.limit:
        cmd.extend(["--limit", str(args.limit)])
    if args.language:
        cmd.extend(["--language", args.language])
    if args.filename:
        cmd.extend(["--filename", args.filename])
    if args.extension:
        cmd.extend(["--extension", args.extension])
    if args.repo:
        for repo in args.repo:
            cmd.extend(["--repo", repo])
    if args.owner:
        for owner in args.owner:
            cmd.extend(["--owner", owner])
    if args.match:
        cmd.extend(["--match", args.match])
    if args.size:
        cmd.extend(["--size", args.size])

    # Always request JSON output with all available fields
    cmd.extend(["--json", "path,repository,sha,textMatches,url"])
    return cmd


def execute_search(cmd: List[str], timeout: int = 60) -> List[Dict[str, Any]]:
    """
    Execute the gh search code command and parse JSON output.

    Args:
        cmd: Command to execute
        timeout: Seconds before killing the subprocess (default: 60)

    Returns:
        List of search results

    Raises:
        GHSearchError: If the command fails or times out
    """
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True,
            timeout=timeout
        )
        return json.loads(result.stdout) if result.stdout.strip() else []

    except subprocess.TimeoutExpired:
        raise GHSearchError(
            f"Search timed out after {timeout}s. Try a simpler query or retry later."
        )
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr.strip()
        if "HTTP 403" in error_msg and "rate limit" in error_msg.lower():
            raise GHSearchError(
                f"GitHub API rate limit exceeded. Wait and retry.\nDetails: {error_msg}"
            )
        elif "HTTP 408" in error_msg:
            raise GHSearchError(
                f"Search query timed out on GitHub's side. Try a simpler query.\nDetails: {error_msg}"
            )
        else:
            raise GHSearchError(f"GitHub search failed: {error_msg}")
    except json.JSONDecodeError as e:
        raise GHSearchError(f"Failed to parse JSON output: {e}")


def filter_results(results: List[Dict[str, Any]], args: argparse.Namespace) -> List[Dict[str, Any]]:
    """Apply custom filters to search results."""
    filtered = results

    if args.exclude_forks:
        filtered = [r for r in filtered if not r.get("repository", {}).get("isFork", False)]
    if args.exclude_private:
        filtered = [r for r in filtered if not r.get("repository", {}).get("isPrivate", False)]
    if args.min_matches:
        filtered = [
            r for r in filtered
            if len(r.get("textMatches", [])) >= args.min_matches
        ]
    return filtered


def sort_results(results: List[Dict[str, Any]], sort_by: Optional[str]) -> List[Dict[str, Any]]:
    """Sort results by specified criteria."""
    if not sort_by:
        return results
    if sort_by == "matches":
        return sorted(results, key=lambda r: len(r.get("textMatches", [])), reverse=True)
    elif sort_by == "repo":
        return sorted(results, key=lambda r: r.get("repository", {}).get("nameWithOwner", ""))
    elif sort_by == "path":
        return sorted(results, key=lambda r: r.get("path", ""))
    return results


def format_json(results: List[Dict[str, Any]]) -> str:
    return json.dumps(results, indent=2)


def format_pretty(results: List[Dict[str, Any]]) -> str:
    if not results:
        return "No results found."

    output = [f"Found {len(results)} result(s)\n", "=" * 80]
    for i, result in enumerate(results, 1):
        repo = result.get("repository", {}).get("nameWithOwner", "Unknown")
        path = result.get("path", "Unknown")
        url = result.get("url", "")
        matches = result.get("textMatches", [])

        output.append(f"\n{i}. {repo}:{path}")
        output.append(f"   URL: {url}")
        output.append(f"   Matches: {len(matches)}")

        if matches:
            fragment = matches[0].get("fragment", "")
            if fragment:
                if len(fragment) > 100:
                    fragment = fragment[:97] + "..."
                output.append(f"   Preview: {fragment}")

        output.append("-" * 80)
    return "\n".join(output)


def format_summary(results: List[Dict[str, Any]]) -> str:
    if not results:
        return "No results found."

    repos = {}
    total_matches = 0
    extensions = {}

    for result in results:
        repo_name = result.get("repository", {}).get("nameWithOwner", "Unknown")
        repos[repo_name] = repos.get(repo_name, 0) + 1
        total_matches += len(result.get("textMatches", []))
        path = result.get("path", "")
        if "." in path:
            ext = path.rsplit(".", 1)[-1]
            extensions[ext] = extensions.get(ext, 0) + 1

    output = [
        "SEARCH SUMMARY",
        "=" * 80,
        f"Total files found: {len(results)}",
        f"Total text matches: {total_matches}",
        f"Unique repositories: {len(repos)}",
        "\nTop Repositories:",
    ]
    for repo, count in sorted(repos.items(), key=lambda x: x[1], reverse=True)[:10]:
        output.append(f"  {repo}: {count} file(s)")
    output.append("\nFile Extensions:")
    for ext, count in sorted(extensions.items(), key=lambda x: x[1], reverse=True):
        output.append(f"  .{ext}: {count} file(s)")
    return "\n".join(output)


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Enhanced wrapper for 'gh search code' with filtering and formatting.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s "hello world" --language python
  %(prog)s "error handling" --repo microsoft/vscode --output pretty
  %(prog)s "TODO" --extension md --exclude-forks --output summary
  %(prog)s "class.*Component" --language typescript --sort-by matches
        """
    )

    parser.add_argument("query", help="Search query (supports GitHub code search syntax)")

    parser.add_argument("-L", "--limit", type=int, default=30,
                        help="Maximum number of results (default: 30)")
    parser.add_argument("--language", help="Filter by programming language")
    parser.add_argument("--filename", help="Filter by filename")
    parser.add_argument("--extension", help="Filter by file extension")
    parser.add_argument("-R", "--repo", action="append",
                        help="Filter by repository (can specify multiple)")
    parser.add_argument("--owner", action="append",
                        help="Filter by owner (can specify multiple)")
    parser.add_argument("--match", choices=["file", "content"],
                        help="Restrict search to file path or content")
    parser.add_argument(
        "--size",
        help=(
            "Filter by file size in bytes using GitHub's range syntax "
            "(e.g. '100..1000' for 100–1000 bytes, '>500' for over 500 bytes). "
            "Note: GitHub code search sizes are in bytes, not KB."
        )
    )

    parser.add_argument("--exclude-forks", action="store_true",
                        help="Exclude results from forked repositories")
    parser.add_argument("--exclude-private", action="store_true",
                        help="Exclude results from private repositories")
    parser.add_argument("--min-matches", type=int,
                        help="Minimum number of text matches per file")

    parser.add_argument("-o", "--output", choices=["json", "pretty", "summary"],
                        default="pretty", help="Output format (default: pretty)")
    parser.add_argument("--sort-by", choices=["matches", "repo", "path"],
                        help="Sort results by criteria")

    args = parser.parse_args()

    try:
        cmd = build_gh_command(args)
        results = execute_search(cmd)
        results = filter_results(results, args)
        results = sort_results(results, args.sort_by)

        if args.output == "json":
            output = format_json(results)
        elif args.output == "summary":
            output = format_summary(results)
        else:
            output = format_pretty(results)

        print(output)
        sys.exit(0)

    except GHSearchError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nSearch cancelled by user.", file=sys.stderr)
        sys.exit(130)
    except Exception as e:
        print(f"Unexpected error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
