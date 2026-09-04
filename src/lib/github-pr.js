import { execa } from 'execa';
import { redactSensitiveData } from './audit-logger.js';

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
  // `gh pr comment <ref>` accepts a full URL, and a URL names a *repository* as
  // well as a PR — so a caller that can choose this value can post as the
  // operator's GitHub identity into a repo they do not own. The only thing any
  // caller here needs is a PR in the current checkout, so the ref is constrained
  // to a bare number and the repo is whatever `cwd` resolves to. This is the
  // shared sink for every caller (CLI flag, MCP tool), so the guard lives here
  // rather than at each entry point.
  let prRef = '';
  if (pr !== undefined && pr !== null && String(pr).trim() !== '') {
    prRef = String(pr).trim();
    if (!/^[0-9]+$/.test(prRef)) {
      return { ok: false, error: `invalid PR reference "${prRef}" — pass a PR number for the current repository, not a URL` };
    }
  }
  // The body is an org snapshot: org id, MFA gaps, inactive users, permissive
  // connected apps. Every other path that ships this material off the machine
  // redacts it first (notifier.js); this one is no different for being a PR.
  const safeBody = redactSensitiveData(body);
  const args = ['pr', 'comment'];
  if (prRef) args.push(prRef);
  args.push('--body', safeBody);
  try {
    const { stdout } = await execa('gh', args, { cwd });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, error: err.stderr || err.shortMessage || err.message };
  }
}
