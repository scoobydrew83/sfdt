// Generic "is this binary on PATH?" probe. Unlike the cached AI/gh helpers in
// ai.js / github-pr.js, this is uncached and returns the version string too.
import { execa } from 'execa';

export async function isToolAvailable(bin, versionArgs = ['--version']) {
  try {
    const { exitCode, stdout } = await execa(bin, versionArgs, { reject: false });
    if (exitCode === 0) {
      const version = String(stdout ?? '').split('\n')[0].trim() || null;
      return { available: true, version };
    }
    return { available: false, version: null };
  } catch {
    return { available: false, version: null };
  }
}
