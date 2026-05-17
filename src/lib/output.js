import chalk from 'chalk';
import ora from 'ora';

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
