import { execa } from 'execa';

/**
 * Facts about a target org that a command needs before it is allowed to change
 * anything.
 *
 * `detectIsProd` was written for `src/commands/deploy.js`, where it only ever
 * chose a test level — it never blocked, prompted, or warned. Promoted here
 * unchanged in behaviour so the write commands can use the same judgement, and
 * so there is one place to fix if the detection is ever wrong.
 */

/**
 * Is this org production?
 *
 * **Fails safe to production.** Some org shapes (Dev Hubs, certain scratch
 * orgs, older `sf` versions) omit `isSandbox` entirely, and reading `undefined`
 * as "not production" would drop the guard on exactly the orgs where it matters
 * most. Anything that is not literally `true` is treated as production, and so
 * is a failed lookup.
 *
 * @param {string} orgAlias
 * @returns {Promise<boolean>}
 */
export async function isProductionOrg(orgAlias) {
  try {
    const { stdout } = await execa('sf', ['org', 'display', '--target-org', orgAlias, '--json']);
    return JSON.parse(stdout)?.result?.isSandbox !== true;
  } catch {
    return true;
  }
}

/**
 * Refuse an org-changing command against production unless it was asked for.
 *
 * Deliberately a hard refusal rather than a prompt: the commands that call this
 * run in CI as often as at a terminal, and a prompt in CI is either a hang or an
 * auto-yes. `--production` is a decision the caller records in their command
 * line, which is also what makes it visible in a CI diff.
 *
 * @param {string} orgAlias
 * @param {object} options - the command's parsed options (`--production`)
 * @param {string} what - what is about to change, named in the error
 */
export async function guardProduction(orgAlias, options, what) {
  if (options.production) return { isProduction: await isProductionOrg(orgAlias), acknowledged: true };
  const isProduction = await isProductionOrg(orgAlias);
  if (isProduction) {
    const err = new Error(
      `"${orgAlias}" looks like a production org and this would ${what}. Re-run with --production ` +
        `to confirm. (Detection fails safe: an org whose sandbox status cannot be read is treated ` +
        `as production.)`,
    );
    err.exitCode = 1;
    throw err;
  }
  return { isProduction, acknowledged: false };
}
