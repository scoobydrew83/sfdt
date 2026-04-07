import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';
import inquirer from 'inquirer';
import { detectProject, getProjectRoot } from '../lib/project-detect.js';
import { print } from '../lib/output.js';

const CONFIG_DIR = '.sfdt';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, '../templates/sfdt.config.json');

async function buildConfigTemplate({ projectName, defaultOrg, features, releaseNotesDir, coverageThreshold }) {
  const template = await fs.readJson(TEMPLATE_PATH);
  return {
    ...template,
    projectName,
    defaultOrg,
    releaseNotesDir,
    deployment: {
      ...template.deployment,
      coverageThreshold,
    },
    features: {
      ...template.features,
      ai: features.ai,
    },
  };
}

function buildEnvironmentsTemplate(defaultOrg) {
  return {
    default: defaultOrg,
    orgs: [{ alias: defaultOrg, type: 'development', description: 'Default development org' }],
  };
}

function buildPullConfigTemplate() {
  return {
    metadataTypes: [
      'ApexClass',
      'ApexTrigger',
      'LightningComponentBundle',
      'CustomObject',
      'CustomField',
      'Layout',
      'FlexiPage',
      'PermissionSet',
      'Flow',
    ],
    targetDir: 'force-app/main/default',
  };
}

function buildTestConfigTemplate(coverageThreshold, testClasses, apexClasses) {
  return {
    coverageThreshold,
    testLevel: 'RunLocalTests',
    suites: [],
    testClasses,
    apexClasses,
  };
}

export function registerInitCommand(program) {
  program
    .command('init')
    .description('Initialize sfdt configuration for a Salesforce DX project')
    .action(async () => {
      try {
        let projectRoot;
        try {
          projectRoot = getProjectRoot();
        } catch {
          print.error(
            'No sfdx-project.json found in this directory or any parent.\n' +
              '  Make sure you are inside a Salesforce DX project.\n' +
              '  Create one with: sf project generate --name my-project',
          );
          process.exitCode = 1;
          return;
        }

        const configDir = path.join(projectRoot, CONFIG_DIR);

        if (await fs.pathExists(configDir)) {
          print.warning(`Configuration already exists at ${configDir}`);
          const { overwrite } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'overwrite',
              message: 'Overwrite existing configuration?',
              default: false,
            },
          ]);
          if (!overwrite) {
            print.info('Init cancelled.');
            return;
          }
        }

        print.header('sfdt init');

        const project = await detectProject(projectRoot);

        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'projectName',
            message: 'Project name:',
            default: project.name,
          },
          {
            type: 'input',
            name: 'defaultOrg',
            message: 'Default org alias:',
            default: '',
            validate: (val) => val.trim().length > 0 || 'Org alias is required',
          },
          {
            type: 'number',
            name: 'coverageThreshold',
            message: 'Code coverage threshold (%):',
            default: 75,
            validate: (val) =>
              (Number.isInteger(val) && val >= 0 && val <= 100) ||
              'Must be an integer between 0 and 100',
          },
          {
            type: 'confirm',
            name: 'aiEnabled',
            message: 'Enable AI-powered features (requires Claude CLI)?',
            default: true,
          },
          {
            type: 'input',
            name: 'releaseNotesDir',
            message: 'Release notes output directory:',
            default: 'release-notes',
          },
        ]);

        // Auto-scan for test classes and apex classes
        const spinner = (await import('../lib/output.js')).createSpinner(
          'Scanning for Apex classes...',
        );
        spinner.start();

        const packageDirs = project.packageDirectories.map((d) => d.absolutePath);
        let testClasses = [];
        let apexClasses = [];

        for (const dir of packageDirs) {
          const testMatches = await glob('**/classes/*Test.cls', { cwd: dir });
          testClasses.push(...testMatches.map((f) => path.basename(f, '.cls')));

          const allMatches = await glob('**/classes/*.cls', { cwd: dir });
          const nonTest = allMatches.filter(
            (f) => !f.endsWith('Test.cls') && !f.endsWith('.cls-meta.xml'),
          );
          apexClasses.push(...nonTest.map((f) => path.basename(f, '.cls')));
        }

        // Deduplicate
        testClasses = [...new Set(testClasses)].sort();
        apexClasses = [...new Set(apexClasses)].sort();

        spinner.succeed(
          `Found ${testClasses.length} test classes and ${apexClasses.length} Apex classes`,
        );

        // Create .sfdt/ directory
        await fs.ensureDir(configDir);

        const config = await buildConfigTemplate({
          projectName: answers.projectName,
          defaultOrg: answers.defaultOrg,
          releaseNotesDir: answers.releaseNotesDir,
          coverageThreshold: answers.coverageThreshold,
          features: {
            ai: answers.aiEnabled,
            notifications: false,
            releaseManagement: true,
          },
        });

        const environments = buildEnvironmentsTemplate(answers.defaultOrg);
        const pullConfig = buildPullConfigTemplate();
        const testConfig = buildTestConfigTemplate(
          answers.coverageThreshold,
          testClasses,
          apexClasses,
        );

        const files = [
          { name: 'config.json', data: config },
          { name: 'environments.json', data: environments },
          { name: 'pull-config.json', data: pullConfig },
          { name: 'test-config.json', data: testConfig },
        ];

        for (const file of files) {
          await fs.writeJson(path.join(configDir, file.name), file.data, { spaces: 2 });
        }

        // Summary
        print.header('Initialization Complete');

        print.success(`Created ${configDir}/`);
        for (const file of files) {
          print.step(`  ${file.name}`);
        }

        console.log('');
        print.info('Detected project settings:');
        print.step(`  Project: ${answers.projectName}`);
        print.step(`  Default org: ${answers.defaultOrg}`);
        print.step(`  Coverage threshold: ${answers.coverageThreshold}%`);
        print.step(`  AI features: ${answers.aiEnabled ? 'enabled' : 'disabled'}`);
        print.step(`  Test classes: ${testClasses.length}`);
        print.step(`  Apex classes: ${apexClasses.length}`);

        console.log('');
        print.warning('Recommended: add the following to your .gitignore:');
        print.step('  .sfdt/*.local.json');
        console.log('');
      } catch (err) {
        print.error(`Init failed: ${err.message}`);
        process.exitCode = 1;
      }
    });
}
