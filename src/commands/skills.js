import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';
import { resolveExitCode } from '../lib/exit-codes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// skills/ lives at package root, which is 2 levels up from src/commands/
const SKILLS_DIR = path.resolve(__dirname, '..', '..', 'skills');

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return { frontmatter: {}, body: content };

  const yamlText = match[1];
  const body = content.slice(match[0].length);

  const frontmatter = {};
  let currentKey = null;
  const lines = yamlText.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;

    // Check for array item like "  - value"
    if (line.trim().startsWith('-') && currentKey) {
      if (!Array.isArray(frontmatter[currentKey])) {
        frontmatter[currentKey] = [];
      }
      const val = line.trim().slice(1).trim().replace(/^['"]|['"]$/g, '');
      frontmatter[currentKey].push(val);
      continue;
    }

    // Check for key-value pair like "key: value" or "key:"
    const colonIndex = line.indexOf(':');
    if (colonIndex !== -1) {
      const key = line.slice(0, colonIndex).trim();
      const val = line.slice(colonIndex + 1).trim().replace(/^['"]|['"]$/g, '');
      currentKey = key;
      if (val) {
        frontmatter[key] = val;
      } else {
        frontmatter[key] = []; // assume list is starting
      }
    }
  }

  return { frontmatter, body };
}

export function registerSkillsCommand(program) {
  const skills = program
    .command('skills')
    .description('Manage sfdt agent skills');

  skills
    .command('export')
    .description('Export local agent skills to IDE/agent-specific configurations')
    .requiredOption(
      '--target <target>',
      'Target IDE/Agent format (claude | cursor | codex | windsurf)',
    )
    .option('--json', 'Emit the result as JSON')
    .action(async (options) => {
      const jsonMode = !!options.json;
      try {
        const target = options.target.toLowerCase();
        const validTargets = ['claude', 'cursor', 'codex', 'windsurf'];
        if (!validTargets.includes(target)) {
          throw new Error(
            `--target must be one of: ${validTargets.join(', ')}. Got: ${options.target}`,
          );
        }

        if (!(await fs.pathExists(SKILLS_DIR))) {
          throw new Error(`Skills directory not found at: ${SKILLS_DIR}`);
        }

        const skillFiles = await glob('**/SKILL.md', { cwd: SKILLS_DIR, absolute: true });
        if (skillFiles.length === 0) {
          throw new Error(`No SKILL.md files found under ${SKILLS_DIR}`);
        }

        const parsedSkills = [];
        for (const file of skillFiles) {
          const content = await fs.readFile(file, 'utf-8');
          const { frontmatter, body } = parseFrontmatter(content);
          parsedSkills.push({
            file: path.relative(SKILLS_DIR, file),
            name: frontmatter.name || path.basename(path.dirname(file)),
            description: frontmatter.description || '',
            triggers: frontmatter.triggers || [],
            body: body.trim(),
          });
        }

        // Compile rules markdown
        let rulesMarkdown = `# Agent Rules & Capabilities\n\n`;
        rulesMarkdown += `These rules are exported from sfdt CLI Skills Pack.\n\n`;
        rulesMarkdown += `---\n\n`;

        for (const skill of parsedSkills) {
          rulesMarkdown += `# Skill: ${skill.name}\n`;
          if (skill.description) {
            rulesMarkdown += `**Description:** ${skill.description}\n`;
          }
          if (skill.triggers && skill.triggers.length > 0) {
            rulesMarkdown += `**Triggers:** ${skill.triggers.join(', ')}\n`;
          }
          rulesMarkdown += `\n## Instructions\n\n`;
          rulesMarkdown += `${skill.body}\n\n`;
          rulesMarkdown += `---\n\n`;
        }

        const filesWritten = [];
        const cwd = process.cwd();

        if (target === 'cursor') {
          const outFile = path.join(cwd, '.cursorrules');
          await fs.writeFile(outFile, rulesMarkdown, 'utf-8');
          filesWritten.push(outFile);
        } else if (target === 'windsurf') {
          const outFile = path.join(cwd, '.windsurfrules');
          await fs.writeFile(outFile, rulesMarkdown, 'utf-8');
          filesWritten.push(outFile);
        } else if (target === 'codex') {
          const outFile = path.join(cwd, '.codexrules');
          await fs.writeFile(outFile, rulesMarkdown, 'utf-8');
          filesWritten.push(outFile);
        } else if (target === 'claude') {
          // Write both .clauderules and .claudecode.json for double compatibility
          const clauderules = path.join(cwd, '.clauderules');
          await fs.writeFile(clauderules, rulesMarkdown, 'utf-8');
          filesWritten.push(clauderules);

          const claudecodeJson = path.join(cwd, '.claudecode.json');
          await fs.writeJson(claudecodeJson, { customInstructions: rulesMarkdown }, { spaces: 2 });
          filesWritten.push(claudecodeJson);
        }

        if (jsonMode) {
          process.stdout.write(
            JSON.stringify(
              {
                ok: true,
                target,
                skillsCount: parsedSkills.length,
                files: filesWritten.map((f) => path.relative(cwd, f)),
              },
              null,
              2,
            ) + '\n',
          );
        } else {
          console.log(chalk.green(`\n✓ Successfully exported skills for ${target}!`));
          console.log(`  Parsed ${parsedSkills.length} skills from sfdt package.`);
          console.log(`  Written config files:`);
          for (const f of filesWritten) {
            console.log(`    ${chalk.dim(path.relative(cwd, f))}`);
          }
          console.log('');
        }
      } catch (err) {
        if (jsonMode) {
          process.stdout.write(
            JSON.stringify({ ok: false, error: err.message, exitCode: resolveExitCode(err) }) + '\n',
          );
        } else {
          console.error(chalk.red(`skills export failed: ${err.message}`));
        }
        process.exitCode = resolveExitCode(err);
      }
    });
}
