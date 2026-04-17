#!/usr/bin/env python3
"""
GitHub Pages Deployment Script

A Python script to automate GitHub Pages deployment using the GitHub CLI (gh).
Supports enabling Pages, checking status, triggering rebuilds, and creating
deployment workflows.

Requirements:
    - GitHub CLI (gh) must be installed and authenticated
    - Python 3.6+

Usage:
    python gh_pages_deploy.py enable <owner>/<repo> [--branch BRANCH] [--path PATH]
    python gh_pages_deploy.py status <owner>/<repo>
    python gh_pages_deploy.py rebuild <owner>/<repo>
    python gh_pages_deploy.py create-workflow [--output PATH]
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Dict, Optional, Tuple

# Paths that create-workflow refuses to write outside of (must be relative or
# inside the current working directory). Prevents accidental overwrites of
# system files when --output is supplied by the user.
_SAFE_OUTPUT_ROOTS = (Path.cwd(),)


def _validate_output_path(output_path: str) -> Path:
    """
    Validate that the output path is safe to write to.

    Accepts only relative paths or paths inside the current working directory.
    Raises ValueError for absolute paths that escape cwd or sensitive locations.

    Args:
        output_path: Raw path string from --output argument

    Returns:
        Resolved Path object guaranteed to be inside cwd

    Raises:
        ValueError: If the path is outside cwd or otherwise unsafe
    """
    p = Path(output_path)

    # Reject absolute paths that aren't inside cwd
    if p.is_absolute():
        try:
            p.relative_to(Path.cwd())
        except ValueError:
            raise ValueError(
                f"--output path must be inside the current directory.\n"
                f"  Received: {output_path}\n"
                f"  CWD:      {Path.cwd()}"
            )
        return p.resolve()

    # Reject relative paths that escape cwd via ../
    resolved = (Path.cwd() / p).resolve()
    try:
        resolved.relative_to(Path.cwd().resolve())
    except ValueError:
        raise ValueError(
            f"--output path must not escape the current directory.\n"
            f"  Received: {output_path}\n"
            f"  Resolved: {resolved}"
        )

    return resolved


class GitHubPagesManager:
    """Manager class for GitHub Pages operations using gh CLI."""

    def __init__(self, repo: str):
        """
        Initialize the manager with a repository.

        Args:
            repo: Repository in format 'owner/repo'
        """
        self.repo = repo
        self._verify_gh_cli()

    def _verify_gh_cli(self) -> None:
        """Verify that gh CLI is installed and authenticated."""
        try:
            result = subprocess.run(
                ['gh', 'auth', 'status'],
                capture_output=True,
                text=True,
                check=False,
                timeout=15
            )
            if result.returncode != 0:
                print("Error: GitHub CLI is not authenticated.", file=sys.stderr)
                print("Run 'gh auth login' to authenticate.", file=sys.stderr)
                sys.exit(1)
        except subprocess.TimeoutExpired:
            print("Error: gh auth check timed out.", file=sys.stderr)
            sys.exit(1)
        except FileNotFoundError:
            print("Error: GitHub CLI (gh) is not installed.", file=sys.stderr)
            print("Install from: https://cli.github.com/", file=sys.stderr)
            sys.exit(1)

    def _run_gh_api(
        self,
        endpoint: str,
        method: str = 'GET',
        data: Optional[Dict] = None,
        check: bool = True,
        timeout: int = 30
    ) -> Tuple[int, Dict]:
        """
        Execute a gh api command.

        Args:
            endpoint: API endpoint (e.g., '/repos/owner/repo/pages')
            method: HTTP method (GET, POST, PUT, DELETE)
            data: Optional data dictionary for POST/PUT requests.
                  Keys and values must be simple strings or booleans;
                  nested dict values are serialized as key[subkey]=value.
            check: Whether to raise RuntimeError on non-zero exit code
            timeout: Seconds before killing the subprocess (default: 30)

        Returns:
            Tuple of (returncode, response_dict)
        """
        cmd = [
            'gh', 'api',
            '-X', method,
            '-H', 'Accept: application/vnd.github+json',
            '-H', 'X-GitHub-Api-Version: 2022-11-28',
            endpoint
        ]

        if data:
            for key, value in data.items():
                if isinstance(value, bool):
                    cmd.extend(['-F', f'{key}={str(value).lower()}'])
                elif isinstance(value, dict):
                    for subkey, subvalue in value.items():
                        cmd.extend(['-f', f'{key}[{subkey}]={subvalue}'])
                else:
                    cmd.extend(['-f', f'{key}={value}'])

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=check,
                timeout=timeout
            )

            response = {}
            if result.stdout.strip():
                try:
                    response = json.loads(result.stdout)
                except json.JSONDecodeError:
                    response = {'raw': result.stdout}

            if result.returncode != 0 and check:
                raise RuntimeError(f"API call failed: {result.stderr or response}")

            return result.returncode, response

        except subprocess.TimeoutExpired:
            raise RuntimeError(f"gh api call timed out after {timeout}s: {endpoint}")
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"Failed to execute gh command: {e.stderr}")

    def enable_pages(
        self,
        branch: str = 'main',
        path: str = '/',
        build_type: str = 'workflow',
        https_enforced: bool = True
    ) -> Dict:
        """
        Enable GitHub Pages for the repository.

        Args:
            branch: Source branch (default: 'main')
            path: Source path, '/' or '/docs' (default: '/')
            build_type: 'workflow' for GitHub Actions or 'legacy' for Jekyll
            https_enforced: Whether to enforce HTTPS (default: True)

        Returns:
            API response dictionary
        """
        print(f"Enabling GitHub Pages for {self.repo}...")
        print(f"  Branch: {branch}")
        print(f"  Path: {path}")
        print(f"  Build type: {build_type}")

        endpoint = f'/repos/{self.repo}/pages'
        data = {
            'source': {'branch': branch, 'path': path},
            'build_type': build_type
        }

        status, response = self._run_gh_api(endpoint, method='POST', data=data, check=False)

        if status == 0:
            print("✓ GitHub Pages enabled successfully!")
            if https_enforced:
                print("  Enforcing HTTPS...")
                self._run_gh_api(
                    endpoint, method='PUT', data={'https_enforced': True}, check=False
                )
            return response
        elif status == 422:
            print("⚠ Pages may already be enabled. Checking status...")
            return self.check_status()
        else:
            error = response.get('message', 'Unknown error')
            print(f"✗ Failed to enable Pages: {error}", file=sys.stderr)
            return response

    def check_status(self) -> Dict:
        """Check GitHub Pages status and configuration."""
        print(f"Checking GitHub Pages status for {self.repo}...")

        endpoint = f'/repos/{self.repo}/pages'
        status, response = self._run_gh_api(endpoint, check=False)

        if status == 0:
            print("\n✓ GitHub Pages is enabled:")
            print(f"  URL: {response.get('html_url', 'N/A')}")
            print(f"  Status: {response.get('status', 'N/A')}")
            print(f"  Build type: {response.get('build_type', 'N/A')}")
            source = response.get('source', {})
            print(f"  Source branch: {source.get('branch', 'N/A')}")
            print(f"  Source path: {source.get('path', 'N/A')}")
            print(f"  HTTPS enforced: {response.get('https_enforced', False)}")
            if response.get('cname'):
                print(f"  Custom domain: {response.get('cname')}")
        else:
            print("✗ GitHub Pages is not enabled for this repository.", file=sys.stderr)

        return response

    def trigger_rebuild(self) -> Dict:
        """Trigger a new GitHub Pages build."""
        print(f"Triggering rebuild for {self.repo}...")

        endpoint = f'/repos/{self.repo}/pages/builds'
        status, response = self._run_gh_api(endpoint, method='POST', check=False)

        if status == 0:
            print("✓ Build triggered successfully!")
            print(f"  Status: {response.get('status', 'N/A')}")
            if 'url' in response:
                print(f"  Build URL: {response['url']}")
        else:
            error = response.get('message', 'Unknown error')
            print(f"✗ Failed to trigger build: {error}", file=sys.stderr)

        return response

    def get_latest_build(self) -> Dict:
        """Get the latest build information."""
        endpoint = f'/repos/{self.repo}/pages/builds/latest'
        status, response = self._run_gh_api(endpoint, check=False)

        if status == 0:
            print("\nLatest build:")
            print(f"  Status: {response.get('status', 'N/A')}")
            print(f"  Commit: {response.get('commit', 'N/A')}")
            if 'created_at' in response:
                print(f"  Created: {response['created_at']}")
            if 'error' in response and response['error'].get('message'):
                print(f"  Error: {response['error']['message']}")

        return response


def create_workflow_file(output_path: Optional[str] = None) -> None:
    """
    Create a GitHub Actions workflow file for Pages deployment.

    The generated workflow is a safe starting template. The build step is
    intentionally left as a commented placeholder — users MUST customize it
    for their specific framework (Next.js, Hugo, plain HTML, etc.).

    Args:
        output_path: Optional custom output path (default: .github/workflows/pages.yml).
                     Must be a relative path or an absolute path inside cwd.
    """
    workflow_content = """\
name: Deploy to GitHub Pages

on:
  push:
    branches: ["main"]
  workflow_dispatch:

# Sets permissions of the GITHUB_TOKEN to allow deployment to GitHub Pages
permissions:
  contents: read
  pages: write
  id-token: write

# Allow only one concurrent deployment
concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Pages
        uses: actions/configure-pages@v5

      - name: Build site
        run: |
          # TODO: Replace with your actual build commands, for example:
          #
          #   Next.js:  npm ci && npm run build
          #   Hugo:     hugo --minify
          #   Jekyll:   bundle exec jekyll build
          #   Plain:    mkdir -p _site && cp -r public/* _site/
          #
          # Ensure your build outputs files into the _site/ directory below.
          echo "Add your build commands here and remove this echo line."
          exit 1  # Remove this line once you have real build commands

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: '_site'

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
"""

    raw_path = output_path or '.github/workflows/pages.yml'

    try:
        resolved = _validate_output_path(raw_path)
    except ValueError as e:
        print(f"✗ {e}", file=sys.stderr)
        sys.exit(1)

    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(workflow_content)

    print(f"✓ Created workflow file at: {resolved}")
    print("\nNext steps:")
    print("1. Replace the placeholder build step with your actual build commands")
    print("2. Ensure your build copies output files into _site/")
    print("3. Commit and push this workflow file")
    print("4. Enable GitHub Pages (source: GitHub Actions) in repo settings, or run:")
    print(f"   python gh_pages_deploy.py enable <owner>/<repo>")


def main():
    """Main entry point for the CLI."""
    parser = argparse.ArgumentParser(
        description='Automate GitHub Pages deployment using gh CLI',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    subparsers = parser.add_subparsers(dest='command', help='Commands')

    enable_parser = subparsers.add_parser('enable', help='Enable GitHub Pages')
    enable_parser.add_argument('repo', help='Repository in format owner/repo')
    enable_parser.add_argument('--branch', default='main', help='Source branch (default: main)')
    enable_parser.add_argument('--path', default='/', choices=['/', '/docs'],
                               help='Source path (default: /)')
    enable_parser.add_argument('--build-type', default='workflow',
                               choices=['workflow', 'legacy'],
                               help='Build type: workflow (GitHub Actions) or legacy (Jekyll)')
    enable_parser.add_argument('--no-https', action='store_true',
                               help='Disable HTTPS enforcement')

    status_parser = subparsers.add_parser('status', help='Check Pages status')
    status_parser.add_argument('repo', help='Repository in format owner/repo')
    status_parser.add_argument('--build-info', action='store_true',
                               help='Show latest build information')

    rebuild_parser = subparsers.add_parser('rebuild', help='Trigger a new build')
    rebuild_parser.add_argument('repo', help='Repository in format owner/repo')

    workflow_parser = subparsers.add_parser('create-workflow',
                                            help='Create GitHub Actions workflow file')
    workflow_parser.add_argument(
        '--output',
        help='Output path relative to cwd (default: .github/workflows/pages.yml). '
             'Absolute paths outside cwd are rejected for safety.'
    )

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    try:
        if args.command == 'enable':
            manager = GitHubPagesManager(args.repo)
            manager.enable_pages(
                branch=args.branch,
                path=args.path,
                build_type=args.build_type,
                https_enforced=not args.no_https
            )
            if args.build_type == 'workflow':
                print("\n💡 Tip: Generate a starter workflow with:")
                print("   python gh_pages_deploy.py create-workflow")

        elif args.command == 'status':
            manager = GitHubPagesManager(args.repo)
            manager.check_status()
            if args.build_info:
                manager.get_latest_build()

        elif args.command == 'rebuild':
            manager = GitHubPagesManager(args.repo)
            manager.trigger_rebuild()

        elif args.command == 'create-workflow':
            create_workflow_file(args.output)

    except Exception as e:
        print(f"\n✗ Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
