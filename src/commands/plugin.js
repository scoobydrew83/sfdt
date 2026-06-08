import fs from 'fs-extra';
import path from 'path';
import inquirer from 'inquirer';
import { execa } from 'execa';
import { print } from '../lib/output.js';

/**
 * Registers the `plugin` and `plugin create` commands in Commander.
 *
 * @param {import('commander').Command} program
 */
export function registerPluginCommand(program) {
  const pluginCmd = program
    .command('plugin')
    .description('Manage sfdt CLI plugins');

  pluginCmd
    .command('create [name]')
    .description('Scaffold a new sfdt CLI plugin project')
    .option('-d, --description <desc>', 'Plugin description')
    .option('-a, --author <author>', 'Plugin author')
    .action(async (name, options) => {
      try {
        let pluginName = name;

        if (!pluginName) {
          const answers = await inquirer.prompt([
            {
              type: 'input',
              name: 'name',
              message: 'Plugin name (should start with sfdt-plugin-):',
              default: 'sfdt-plugin-custom',
              validate: (val) => val.trim().length > 0 || 'Plugin name is required',
            },
          ]);
          pluginName = answers.name.trim();
        }

        if (!pluginName.startsWith('sfdt-plugin-')) {
          print.warning(
            `Warning: Plugin name "${pluginName}" does not start with "sfdt-plugin-".\n` +
              '  Auto-discovery in sfdt requires plugins to match "sfdt-plugin-*" (or scoped packages like "@org/sfdt-plugin-*").\n' +
              '  You will need to register this plugin explicitly in the config.plugins array.'
          );
        }

        let description = options.description;
        let author = options.author;

        const prompts = [];
        if (description === undefined) {
          prompts.push({
            type: 'input',
            name: 'description',
            message: 'Description:',
            default: 'A custom plugin for sfdt',
          });
        }
        if (author === undefined) {
          let defaultAuthor = '';
          try {
            const { stdout } = await execa('git', ['config', 'user.name']);
            defaultAuthor = stdout.trim();
          } catch {
            // Ignore if git config fails
          }
          prompts.push({
            type: 'input',
            name: 'author',
            message: 'Author:',
            default: defaultAuthor,
          });
        }

        if (prompts.length > 0) {
          const answers = await inquirer.prompt(prompts);
          description = description ?? answers.description;
          author = author ?? answers.author;
        }

        const targetDir = path.resolve(process.cwd(), pluginName);

        if (await fs.pathExists(targetDir)) {
          throw new Error(`Directory "${pluginName}" already exists at ${targetDir}.`);
        }

        print.header(`Scaffolding plugin: ${pluginName}`);

        // 1. Create directory structure
        await fs.ensureDir(targetDir);
        await fs.ensureDir(path.join(targetDir, 'test'));

        // 2. Generate package.json
        const packageJson = {
          name: pluginName,
          version: '0.1.0',
          description: description || 'A custom plugin for sfdt',
          main: 'index.js',
          type: 'module',
          scripts: {
            test: 'vitest run',
          },
          author: author || '',
          license: 'MIT',
          peerDependencies: {
            '@sfdt/cli': '*',
          },
          devDependencies: {
            vitest: '^1.0.0',
          },
        };

        // 3. Generate index.js
        const indexJs = `/**
 * sfdt plugin entry point
 *
 * @param {import('commander').Command} program - The root Commander program instance
 */
export function register(program) {
  program
    .command('hello-plugin')
    .description('Print a message from the custom plugin')
    .option('--name <name>', 'Name to greet', 'Developer')
    .action((options) => {
      console.log(\`Hello, \${options.name}! Welcome to sfdt custom plugin development.\`);
    });
}
`;

        // 4. Generate test/index.test.js
        const testJs = `import { describe, it, expect, vi } from 'vitest';
import { register } from '../index.js';

describe('sfdt Custom Plugin', () => {
  it('registers the hello-plugin command', () => {
    // Create a mock Commander program
    const mockCommand = {
      description: vi.fn().mockReturnThis(),
      option: vi.fn().mockReturnThis(),
      action: vi.fn().mockReturnThis(),
    };
    
    const mockProgram = {
      command: vi.fn().mockReturnValue(mockCommand),
    };

    register(mockProgram);

    expect(mockProgram.command).toHaveBeenCalledWith('hello-plugin');
    expect(mockCommand.description).toHaveBeenCalled();
    expect(mockCommand.option).toHaveBeenCalled();
    expect(mockCommand.action).toHaveBeenCalled();
  });
});
`;

        // 5. Generate README.md
        const readmeMd = `# ${pluginName}

${description || 'A custom plugin for sfdt'}

This is a custom plugin for the \`sfdt\` CLI.

## Installation

1. Install the plugin package in your Salesforce DX project:
   \`\`\`bash
   npm install ${pluginName} --save-dev
   \`\`\`
2. Add the plugin name to \`.sfdt/config.json\`:
   \`\`\`json
   {
     "plugins": [
       "${pluginName}"
     ]
   }
   \`\`\`
3. Alternatively, enable plugin auto-discovery in \`.sfdt/config.json\`:
   \`\`\`json
   {
     "pluginOptions": {
       "autoDiscover": true
     }
   }
   \`\`\`

## Development & Testing

To run tests for this plugin:
\`\`\`bash
npm install
npm test
\`\`\`
`;

        // Write files
        await fs.writeJson(path.join(targetDir, 'package.json'), packageJson, { spaces: 2 });
        await fs.writeFile(path.join(targetDir, 'index.js'), indexJs, 'utf8');
        await fs.writeFile(path.join(targetDir, 'test/index.test.js'), testJs, 'utf8');
        await fs.writeFile(path.join(targetDir, 'README.md'), readmeMd, 'utf8');

        print.success(`Successfully created custom plugin project at: ${targetDir}`);
        print.step('Next steps:');
        print.step(`  1. cd ${pluginName}`);
        print.step('  2. npm install');
        print.step('  3. npm test');
      } catch (err) {
        print.error(`Plugin creation failed: ${err.message}`);
        process.exitCode = 1;
      }
    });
}
