/**
 * Pure helpers for building the shell command that the extension sends to a VS
 * Code integrated terminal. Free of any `vscode` import so it can be unit-tested.
 * The terminal itself (creation, sendText) lives in the extension wiring layer.
 */

import { buildArgs } from './cli.js';

/** Quote a single argv token for a POSIX-ish shell if it needs it. */
export function shellQuote(token: string): string {
  if (token.length > 0 && /^[A-Za-z0-9_./:=@-]+$/.test(token)) return token;
  // Wrap in single quotes, escaping any embedded single quote.
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

export interface TerminalCommandOptions {
  /** Path to the sfdt binary (defaults to "sfdt" on PATH). */
  cliPath?: string;
  /** Org alias appended as `--org <alias>` when set and not already present. */
  org?: string;
}

/**
 * Build the full shell command line for an sfdt invocation, e.g.
 * `sfdt audit all --org "My Org"`. Reuses buildArgs() so the `--org` rule
 * matches the output-channel runner exactly.
 */
export function buildTerminalCommand(args: string[], options: TerminalCommandOptions = {}): string {
  const { cliPath = 'sfdt', org } = options;
  const argv = buildArgs(args, org);
  return [cliPath, ...argv].map(shellQuote).join(' ');
}
