import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';
import { resolveExitCode } from '../lib/exit-codes.js';
import { emitJson, emitJsonError } from '../lib/output.js';

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

// Eval prompt seeds (skills/<name>/evals/) are authoring/benchmarking assets —
// they must not ship in exported packs or installed .claude/skills folders.
function isEvalFile(relOrAbsPath) {
  return relOrAbsPath.split(/[\\/]/).includes('evals');
}

/**
 * Emit an `npx skills add`-compatible pack from the parsed skills.
 * Produces `<out>/manifest.json` (vercel-labs/skills schema, as used by
 * forcedotcom/sf-skills) plus a copy of every skill folder under `<out>/skills/`.
 */
async function exportPack(parsedSkills, outOption) {
  const outDir = path.resolve(process.cwd(), outOption || 'sfdt-skills-pack');

  // Enumerate every file under the package skills/ dir once, then group by folder.
  const allFiles = (await glob('**/*', { cwd: SKILLS_DIR, nodir: true }))
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => !isEvalFile(f));

  // Start from a clean skills/ tree so a renamed or removed skill doesn't leave a
  // stale folder behind on re-export — keeps the pack reproducible from the source.
  await fs.emptyDir(path.join(outDir, 'skills'));

  const manifestSkills = [];
  for (const skill of parsedSkills) {
    const folderRel = path.dirname(skill.file).split(path.sep).join('/');
    const prefix = `${folderRel}/`;
    const files = allFiles
      .filter((f) => f.startsWith(prefix))
      .map((f) => f.slice(prefix.length))
      // SKILL.md first, remaining files alphabetically — matches sf-skills ordering.
      .sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)));

    await fs.copy(path.join(SKILLS_DIR, folderRel), path.join(outDir, 'skills', folderRel), {
      filter: (src) => !isEvalFile(path.relative(SKILLS_DIR, src)),
    });

    manifestSkills.push({
      name: skill.name,
      path: `skills/${folderRel}/SKILL.md`,
      folderPath: `skills/${folderRel}`,
      category: skill.name.startsWith('sfdt') ? 'sfdt' : 'salesforce',
      files,
      description: skill.description,
    });
  }

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    skills: manifestSkills,
  };
  const manifestPath = path.join(outDir, 'manifest.json');
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });

  // The mirror repo (scoobydrew83/sfdt-skills) carries a hand-written README whose
  // footer records which CLI version it was synced from. Own that one line here,
  // derived from package.json, so *every* sync path — CI and the documented manual
  // `sfdt skills export --target pack` command — bumps it in lockstep and it can
  // never drift out of step with the shipped version (harness H-014).
  const readmePath = path.join(outDir, 'README.md');
  let readmeSynced = false;
  if (await fs.pathExists(readmePath)) {
    const { version } = await fs.readJson(path.resolve(SKILLS_DIR, '..', 'package.json'));
    const readme = await fs.readFile(readmePath, 'utf-8');
    const footerRe = /Synced from `@sfdt\/cli` v\d+\.\d+\.\d+\./;
    const updated = readme.replace(footerRe, `Synced from \`@sfdt/cli\` v${version}.`);
    if (updated !== readme) {
      await fs.writeFile(readmePath, updated, 'utf-8');
      readmeSynced = true;
    }
  }

  const cwd = process.cwd();
  return {
    skillsCount: manifestSkills.length,
    outDir: path.relative(cwd, outDir) || '.',
    manifest: path.relative(cwd, manifestPath),
    skills: manifestSkills.map((s) => s.name),
    readmeSynced,
  };
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
      'Target IDE/Agent format (claude | cursor | codex | windsurf | pack)',
    )
    .option(
      '--out <dir>',
      'Output directory for --target pack (default: ./sfdt-skills-pack)',
    )
    .option('--json', 'Emit the result as JSON')
    .action(async (options) => {
      const jsonMode = !!options.json;
      try {
        const target = options.target.toLowerCase();
        const validTargets = ['claude', 'cursor', 'codex', 'windsurf', 'pack'];
        if (!validTargets.includes(target)) {
          throw new Error(
            `--target must be one of: ${validTargets.join(', ')}. Got: ${options.target}`,
          );
        }

        if (!(await fs.pathExists(SKILLS_DIR))) {
          throw new Error(`Skills directory not found at: ${SKILLS_DIR}`);
        }

        // glob() gives no ordering guarantee, so sort — every target downstream
        // renders in this order (pack manifest, rules markdown, .claude/skills).
        // Unsorted, each export reshuffles skills and shows up as a spurious diff
        // in the generated pack repo.
        const skillFiles = (await glob('**/SKILL.md', { cwd: SKILLS_DIR, absolute: true })).sort(
          (a, b) => a.localeCompare(b),
        );
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

        // `pack` target emits an `npx skills add`-compatible pack (manifest.json +
        // skill folders), mirroring forcedotcom/sf-skills, rather than IDE rules files.
        if (target === 'pack') {
          const result = await exportPack(parsedSkills, options.out);
          if (jsonMode) {
            emitJson({ ok: true, target, ...result });
          } else {
            console.log(chalk.green(`\n✓ Exported ${result.skillsCount} skills as an npx-skills pack!`));
            console.log(`  Output: ${chalk.dim(result.outDir)}`);
            console.log(`  Manifest: ${chalk.dim(result.manifest)}`);
            console.log(chalk.dim(`\n  Install with:  npx skills add ${result.outDir}`));
            console.log('');
          }
          return;
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
          // Primary: the real Claude Code convention — project skills live as
          // folders under .claude/skills/<name>/ and are discovered natively
          // (name + description frontmatter drive triggering).
          for (const skill of parsedSkills) {
            const folderRel = path.dirname(skill.file).split(path.sep).join('/');
            const dest = path.join(cwd, '.claude', 'skills', folderRel);
            await fs.copy(path.join(SKILLS_DIR, folderRel), dest, {
              filter: (src) => !isEvalFile(path.relative(SKILLS_DIR, src)),
            });
            filesWritten.push(dest);
          }

          // Legacy compatibility files kept for older tooling that read them
          const clauderules = path.join(cwd, '.clauderules');
          await fs.writeFile(clauderules, rulesMarkdown, 'utf-8');
          filesWritten.push(clauderules);

          const claudecodeJson = path.join(cwd, '.claudecode.json');
          await fs.writeJson(claudecodeJson, { customInstructions: rulesMarkdown }, { spaces: 2 });
          filesWritten.push(claudecodeJson);
        }

        if (jsonMode) {
          emitJson({
            ok: true,
            target,
            skillsCount: parsedSkills.length,
            files: filesWritten.map((f) => path.relative(cwd, f)),
          });
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
          emitJsonError(err);
        } else {
          console.error(chalk.red(`skills export failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });
}
