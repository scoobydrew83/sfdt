import { execa } from 'execa';

/**
 * Thin wrapper around the GitHub CLI (`gh`) for posting PR comments. Mirrors how
 * `scripts/core/deployment-assistant.sh` already shells `gh` — no octokit
 * dependency. All functions check availability first and surface clear errors.
 */

/** True when the `gh` CLI is installed and on PATH. */
export async function isGhAvailable() {
  try {
    await execa('gh', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Post a comment to a pull request via `gh pr comment`. With no `pr`, gh targets
 * the PR for the current branch.
 *
 * @param {string} body - Markdown comment body.
 * @param {object} [options]
 * @param {string} [options.pr] - PR number or URL (optional).
 * @param {string} [options.cwd]
 * @returns {Promise<{ ok: boolean, stdout?: string, error?: string }>}
 */
export async function postPrComment(body, { pr, cwd } = {}) {
  if (!body || !body.trim()) return { ok: false, error: 'empty comment body' };
  if (!(await isGhAvailable())) {
    return { ok: false, error: 'gh CLI not found — install GitHub CLI and authenticate (gh auth login)' };
  }
  const args = ['pr', 'comment'];
  if (pr) args.push(String(pr));
  args.push('--body', body);
  try {
    const { stdout } = await execa('gh', args, { cwd });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, error: err.stderr || err.shortMessage || err.message };
  }
}
