import { execa } from 'execa';

// Refs that start with '-' would be parsed by git as option flags rather
// than refs; the rest of the class covers branch names, tags, SHAs, and
// rev syntax (~, ^, @{...}, refs/heads/...).
export const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9._/~^@:{}][A-Za-z0-9._/~^@:{}-]*$/;

export function isSafeGitRef(ref) {
  return typeof ref === 'string' && SAFE_GIT_REF_PATTERN.test(ref);
}

/**
 * Resolve a diff base ref. If the caller passed a branch name, prefer the
 * merge-base with head so the diff excludes changes already on the base
 * branch. Commit SHAs are trusted as-is.
 *
 * @param {string} base - Base ref (branch name or SHA)
 * @param {string} head - Head ref
 * @param {string} cwd - Repository root
 * @returns {Promise<string>} merge-base SHA, or `base` unchanged
 */
export async function resolveBaseRef(base, head, cwd) {
  // If the caller passed a specific commit SHA we trust it as-is.
  if (/^[0-9a-f]{7,40}$/i.test(base)) return base;

  const mergeBase = await execa('git', ['merge-base', base, head], { cwd, reject: false });
  if (mergeBase.exitCode === 0 && mergeBase.stdout.trim()) {
    return mergeBase.stdout.trim();
  }
  return base;
}

/**
 * Run `git diff --name-status <base> <head> -- <paths...>`.
 * Does not throw on non-zero exit; callers inspect exitCode/stderr.
 *
 * @param {string} base
 * @param {string} head
 * @param {string[]} paths - Path prefixes to scope the diff
 * @param {string} cwd - Repository root
 * @returns {Promise<import('execa').Result>}
 */
export async function diffNameStatus(base, head, paths, cwd) {
  return execa(
    'git',
    ['diff', '--name-status', base, head, '--', ...paths],
    { cwd, reject: false },
  );
}
