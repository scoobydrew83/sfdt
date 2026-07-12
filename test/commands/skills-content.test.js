import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCli } from '../../src/cli.js';

// Content invariants for the bundled skills under skills/. These read the REAL
// files (no mocks): the skills ship in the npm package and are exported into
// user projects, so drift between them and the CLI is a user-facing bug.
// See docs/skills-audit-2026-07-12.md for the audit that motivated this guard.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.resolve(TEST_DIR, '..', '..', 'skills');

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return {};
  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colonIndex = line.indexOf(':');
    if (colonIndex !== -1 && !line.trim().startsWith('-')) {
      const key = line.slice(0, colonIndex).trim();
      const val = line
        .slice(colonIndex + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '');
      if (val) frontmatter[key] = val;
    }
  }
  return frontmatter;
}

const skillDirs = fs
  .readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

describe('bundled skills content invariants', () => {
  it('finds the bundled skills', () => {
    expect(skillDirs.length).toBeGreaterThanOrEqual(10);
  });

  it.each(skillDirs)('%s has valid SKILL.md frontmatter', (dir) => {
    const skillPath = path.join(SKILLS_DIR, dir, 'SKILL.md');
    expect(fs.existsSync(skillPath), `${dir}/SKILL.md missing`).toBe(true);

    const fm = parseFrontmatter(fs.readFileSync(skillPath, 'utf-8'));
    // name must match the folder — skill libraries key installs off it
    expect(fm.name).toBe(dir);
    // description drives triggering; the agent-skills spec caps it at 1024 chars
    expect(fm.description, `${dir} description missing`).toBeTruthy();
    expect(fm.description.length).toBeLessThanOrEqual(1024);
    // license is required by skill registries/marketplaces
    expect(fm.license, `${dir} missing license frontmatter`).toBe('Apache-2.0');
  });

  it.each(skillDirs)('%s has committed eval prompt seeds', (dir) => {
    const evalsPath = path.join(SKILLS_DIR, dir, 'evals', 'evals.json');
    expect(fs.existsSync(evalsPath), `${dir}/evals/evals.json missing`).toBe(true);

    const evals = JSON.parse(fs.readFileSync(evalsPath, 'utf-8'));
    expect(evals.skill_name).toBe(dir);
    expect(Array.isArray(evals.evals)).toBe(true);
    expect(evals.evals.length).toBeGreaterThanOrEqual(2);
    for (const e of evals.evals) {
      expect(typeof e.prompt).toBe('string');
      expect(e.prompt.length).toBeGreaterThan(20);
    }
  });
});

describe('sfdt-cli skill stays in sync with the CLI', () => {
  const skillText =
    fs.readFileSync(path.join(SKILLS_DIR, 'sfdt-cli', 'SKILL.md'), 'utf-8') +
    fs.readFileSync(path.join(SKILLS_DIR, 'sfdt-cli', 'references', 'commands.md'), 'utf-8');

  it('documents every registered top-level command', () => {
    const program = createCli();
    const commandNames = program.commands
      .map((cmd) => cmd.name())
      .filter((name) => name !== 'help');

    const missing = commandNames.filter(
      (name) => !new RegExp(`sfdt ${name}\\b`).test(skillText),
    );

    // When this fails: a command was added/renamed in src/cli.js without
    // updating skills/sfdt-cli/SKILL.md or references/commands.md.
    expect(missing).toEqual([]);
  });
});
