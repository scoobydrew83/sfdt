/**
 * Build repeated `--source-dir <path>` argument pairs for `sf project
 * retrieve` commands from configured packageDirectories, falling back to
 * the default source path.
 *
 * @param {object} config - Loaded sfdt config
 * @returns {string[]} e.g. ['--source-dir', 'force-app/main/default']
 */
export function buildSourceDirArgs(config) {
  const dirs = config.packageDirectories?.length
    ? config.packageDirectories.map((d) => d.path)
    : [config.defaultSourcePath ?? 'force-app/main/default'];
  return dirs.flatMap((d) => ['--source-dir', d]);
}
