import chalk from 'chalk';
import ora from 'ora';

const SPLASH_INDIGO = '#4F46E5';
const SPLASH_VIOLET = '#7C3AED';

const SPLASH_BLOCK = [
  '   ███████╗███████╗██████╗ ████████╗',
  '   ██╔════╝██╔════╝██╔══██╗╚══██╔══╝',
  '   ███████╗█████╗  ██║  ██║   ██║   ',
  '   ╚════██║██╔══╝  ██║  ██║   ██║   ',
  '   ███████║██║     ██████╔╝   ██║   ',
  '   ╚══════╝╚═╝     ╚═════╝    ╚═╝   ',
];

const SPLASH_COMPACT = [
  '   ┌─────────────────────────────────────┐',
  '   │   ___  ___    _   _                 │',
  '   │  / __||  _|__| |_| |                │',
  '   │  \\__ \\|  _/ _` |  _|   Salesforce   │',
  '   │  |___/|_| \\__,_|\\__|   DevOps Tools │',
  '   └─────────────────────────────────────┘',
];

/**
 * Build the sfdt splash banner as a string. Falls back to a single-line
 * label when stdout is not a TTY (CI logs, piped output).
 *
 * @param {object} opts
 * @param {string} opts.version - Package version to render in the tagline.
 * @param {'compact'|'block'} [opts.size='compact'] - Banner size.
 * @returns {string} The fully formatted, color-applied banner.
 */
export function formatSplash({ version, size = 'compact' } = {}) {
  if (!process.stdout.isTTY) {
    return `sfdt · Salesforce DevOps Toolkit · v${version}`;
  }

  const indigo = chalk.hex(SPLASH_INDIGO);
  const violet = chalk.hex(SPLASH_VIOLET);
  const dim = chalk.gray;
  const lines = [''];

  if (size === 'block') {
    for (const line of SPLASH_BLOCK) lines.push(indigo(line));
    lines.push('');
    lines.push(violet('   Salesforce DevOps Toolkit') + dim(` · v${version}`));
  } else {
    for (const line of SPLASH_COMPACT) lines.push(indigo(line));
    lines.push(dim(`            v${version} · sfdt.dev`));
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Print the sfdt splash banner directly to stdout.
 *
 * @param {object} opts - Same shape as {@link formatSplash}.
 */
export function printSplash(opts) {
  console.log(formatSplash(opts));
}

export const print = {
  success(msg) {
    console.log(chalk.green(`  ${msg}`));
  },

  error(msg) {
    console.error(chalk.red(`  ${msg}`));
  },

  warning(msg) {
    console.log(chalk.yellow(`  ${msg}`));
  },

  info(msg) {
    console.log(chalk.cyan(`  ${msg}`));
  },

  step(msg) {
    console.log(chalk.white(`  ${msg}`));
  },

  header(title) {
    const line = '-'.repeat(title.length + 4);
    console.log('');
    console.log(chalk.bold.cyan(line));
    console.log(chalk.bold.cyan(`  ${title}`));
    console.log(chalk.bold.cyan(line));
    console.log('');
  },
};

/**
 * Create an ora spinner instance with consistent styling.
 *
 * @param {string} text - Initial spinner text
 * @returns {import('ora').Ora} The spinner instance
 */
export function createSpinner(text) {
  return ora({
    text,
    color: 'cyan',
    spinner: 'dots',
  });
}
