/**
 * Pure helpers for the Apex "Run this test class" CodeLens. Detects whether a
 * `.cls` source is an Apex test class and derives the class name (which
 * `sfdt test --class-names <name>` runs). Free of any `vscode` import.
 */

import { basenameWithoutSuffix } from './basename.js';

/** Glob (and CodeLens document pattern) for Apex classes. */
export const APEX_CLASS_GLOB = '**/*.cls';

/**
 * Whether an Apex source is a test class — i.e. it carries an `@IsTest`
 * annotation or the legacy `testMethod` keyword. Case-insensitive; tolerant of
 * whitespace between `@` and `IsTest`. Line/# comments are stripped first so a
 * commented-out annotation doesn't count.
 */
export function isApexTestClass(source: string): boolean {
  if (!source) return false;
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/\/\/[^\n]*/g, ' '); // line comments
  return /@\s*isTest\b/i.test(code) || /\btestMethod\b/i.test(code);
}

/** Derive the Apex class name from a `.cls` file path, or null when not a class file. */
export function classNameFromFile(filePath: string): string | null {
  return basenameWithoutSuffix(filePath, '.cls');
}
