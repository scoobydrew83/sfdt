import { print } from '../lib/output.js';

/**
 * All commands with their flags, kept in sync with registrations in cli.js.
 * Used to generate static completion scripts for bash, zsh, and fish.
 */
const COMMAND_COMPLETIONS = {
  init: [],
  deploy: ['--managed', '--skip-preflight', '--dry-run'],
  release: [],
  test: ['--legacy', '--analyze', '--dry-run'],
  pull: ['--dry-run'],
  quality: ['--tests', '--all', '--fix-plan', '--generate-stubs', '--dry-run'],
  preflight: ['--strict', '--dry-run'],
  rollback: ['--org', '--dry-run'],
  smoke: ['--org', '--dry-run'],
  review: ['--base'],
  notify: ['--version', '--org', '--message'],
  drift: ['--org'],
  changelog: [],
  manifest: ['--base', '--head', '--output', '--destructive', '--ai-cleanup', '--no-ai-cleanup', '--print'],
  explain: ['--from-stdin', '--latest'],
  'pr-description': ['--base', '--head', '--format', '--output', '--commit-limit'],
  ui: ['--port', '--no-open'],
  compare: ['--source', '--target', '--output'],
  completion: ['bash', 'zsh', 'fish'],
  version: [],
  help: [],
};

const COMMAND_DESCRIPTIONS = {
  init: 'Initialize .sfdt/ configuration for a Salesforce DX project',
  deploy: 'Deploy to a Salesforce org',
  release: 'Generate a release manifest and release notes',
  test: 'Run Apex tests with the enhanced test runner',
  pull: 'Pull metadata changes from the default org',
  quality: 'Run code quality analysis',
  preflight: 'Run pre-deployment validation checks',
  rollback: 'Roll back a deployment to a target org',
  smoke: 'Run post-deployment smoke tests',
  review: 'AI-powered Salesforce code review',
  notify: 'Send a notification to Slack for deployment events',
  drift: 'Detect metadata drift between local source and a target org',
  changelog: 'Manage project CHANGELOG.md',
  manifest: 'Smart package.xml generator from git diffs',
  explain: 'AI-powered analysis of a Salesforce deployment error log',
  'pr-description': 'Generate a PR description or Slack message',
  ui: 'Launch the local SFDT web dashboard',
  compare: 'Compare metadata between two orgs or an org and local source',
  completion: 'Output shell completion script (bash|zsh|fish)',
  version: 'Show the sfdt version',
  help: 'Show help for a command',
};

function generateBash() {
  const commandList = Object.keys(COMMAND_COMPLETIONS).join(' ');

  const caseClauses = Object.entries(COMMAND_COMPLETIONS)
    .filter(([, flags]) => flags.length > 0)
    .map(([cmd, flags]) => `    ${cmd}) opts="${flags.join(' ')}" ;;`)
    .join('\n');

  return `# sfdt bash completion
# Add this to your ~/.bashrc or ~/.bash_profile:
#   source <(sfdt completion bash)
# Or save to a file and source it:
#   sfdt completion bash > ~/.sfdt-completion.bash
#   echo 'source ~/.sfdt-completion.bash' >> ~/.bashrc

_sfdt_completions() {
  local cur prev opts
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local commands="${commandList}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
    return 0
  fi

  local cmd="\${COMP_WORDS[1]}"
  local opts="--help"
  case "\${cmd}" in
${caseClauses}
  esac

  COMPREPLY=( $(compgen -W "\${opts} --help" -- "\${cur}") )
  return 0
}

complete -F _sfdt_completions sfdt
`;
}

function generateZsh() {
  const commandEntries = Object.entries(COMMAND_DESCRIPTIONS)
    .map(([cmd, desc]) => `    '${cmd}:${desc}'`)
    .join('\n');

  const caseClauses = Object.entries(COMMAND_COMPLETIONS)
    .filter(([, flags]) => flags.length > 0)
    .map(([cmd, flags]) => {
      const args = flags.map((f) => `'${f}[${f}]'`).join(' ');
      return `      (${cmd})\n        _arguments ${args} '(-h --help)'{-h,--help}'[Show help]' ;;`;
    })
    .join('\n');

  return `#compdef sfdt
# sfdt zsh completion
# Add this to your ~/.zshrc:
#   source <(sfdt completion zsh)
# Or save to a completions directory:
#   sfdt completion zsh > "\${fpath[1]}/_sfdt"

_sfdt() {
  local state line
  typeset -A opt_args

  _arguments \\
    '(-v --version)'{-v,--version}'[Show version number]' \\
    '(-h --help)'{-h,--help}'[Show help]' \\
    '1: :_sfdt_commands' \\
    '*:: :->args'

  case \$state in
    args)
      case \$words[1] in
${caseClauses}
        *)
          _arguments '(-h --help)'{-h,--help}'[Show help]' ;;
      esac ;;
  esac
}

_sfdt_commands() {
  local -a commands
  commands=(
${commandEntries}
  )
  _describe 'sfdt commands' commands
}

_sfdt
`;
}

function generateFish() {
  const commandLines = Object.entries(COMMAND_DESCRIPTIONS)
    .map(([cmd, desc]) => `complete -c sfdt -n '__fish_use_subcommand' -a ${cmd} -d '${desc}'`)
    .join('\n');

  const flagLines = Object.entries(COMMAND_COMPLETIONS)
    .filter(([, flags]) => flags.length > 0)
    .flatMap(([cmd, flags]) =>
      flags
        .filter((f) => f.startsWith('--'))
        .map((f) => {
          const name = f.replace(/^--/, '');
          return `complete -c sfdt -n '__fish_seen_subcommand_from ${cmd}' -l ${name}`;
        }),
    )
    .join('\n');

  return `# sfdt fish completion
# Add this to your fish config:
#   sfdt completion fish > ~/.config/fish/completions/sfdt.fish
# Or source it directly:
#   sfdt completion fish | source

# Disable default file completions for sfdt
complete -c sfdt -f

# Commands
${commandLines}

# Per-command flags
${flagLines}

# Global flags (available for all subcommands)
complete -c sfdt -n '__fish_seen_subcommand_from ${Object.keys(COMMAND_COMPLETIONS).join(' ')}' -s h -l help -d 'Show help'
`;
}

export function registerCompletionCommand(program) {
  program
    .command('completion [shell]')
    .description('Output shell completion script (bash, zsh, or fish)')
    .addHelpText(
      'after',
      `
Examples:
  # Bash — add to ~/.bashrc:
  source <(sfdt completion bash)

  # Zsh — add to ~/.zshrc:
  source <(sfdt completion zsh)

  # Fish — save to completions dir:
  sfdt completion fish > ~/.config/fish/completions/sfdt.fish`,
    )
    .action((shell) => {
      const target = (shell || '').toLowerCase();

      if (!target || !['bash', 'zsh', 'fish'].includes(target)) {
        print.error(`Specify a shell: sfdt completion <bash|zsh|fish>`);
        print.info('');
        print.info('Examples:');
        print.step('  source <(sfdt completion bash)');
        print.step('  source <(sfdt completion zsh)');
        print.step('  sfdt completion fish > ~/.config/fish/completions/sfdt.fish');
        process.exitCode = 1;
        return;
      }

      let script;
      if (target === 'bash') script = generateBash();
      else if (target === 'zsh') script = generateZsh();
      else script = generateFish();

      process.stdout.write(script);
    });
}
