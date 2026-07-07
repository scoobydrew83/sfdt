/**
 * Allowlist + argv builder for GUI-triggered runs of native (Node) sfdt
 * commands.
 *
 * The generic /api/command/run endpoint covers the shell-script commands in
 * its COMMANDS map (preflight, drift, test, quality, deploy, rollback). The
 * commands below have no shell script — audit, monitor, scratch, data, and
 * docs are native runners — so the GUI re-invokes the sfdt CLI entrypoint
 * itself (same convention as the dashboard's `runSfdtJson` helper and
 * mcp-server.js) and streams its output over SSE.
 *
 * Every command here is a FIXED argv template: the only user-controlled
 * pieces are strictly validated values (org alias, scratch alias/target,
 * data-set name, small integers). Nothing from the request body is ever
 * interpolated into a shell string — the argv array goes straight to execa.
 * Irreversible operations (scratch delete, data delete) always get `--yes`
 * appended because the child runs non-interactively; the GUI shows its own
 * confirmation dialog before calling the endpoint.
 */

// Mirrors the ORG_ALIAS_RE used by the sibling gui-server routes (session
// org, compare, pull): first char alphanumeric or '@' so a flag-style value
// can't sneak into the child argv.
const ORG_RE = /^[A-Za-z0-9@][A-Za-z0-9_.\-@]*$/;

// Data-set names become a path segment under the data dir — keep them to a
// conservative identifier charset (no dots, slashes, or leading '-').
const SET_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// AiEvaluationDefinition API name (agent-test spec) — a Salesforce DeveloperName.
const DEV_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

// Comma-separated metadata type list for retrofit (e.g. "CustomObject,Flow").
const METADATA_LIST_RE = /^[A-Za-z0-9_]+(?:,[A-Za-z0-9_]+)*$/;

const CLI_RUN_COMMAND_NAMES = new Set([
  'audit',
  'monitor',
  'scratch-create',
  'scratch-delete',
  'scratch-pool-fill',
  'data-export',
  'data-import',
  'data-delete',
  'docs-generate',
  'agent-test',
  'retrofit',
]);

/** True when `command` is one of the allowlisted native-CLI run commands. */
export function isCliRunCommand(command) {
  return CLI_RUN_COMMAND_NAMES.has(command);
}

/**
 * Build the sfdt argv for an allowlisted native command.
 *
 * @param {string} command     Allowlist key (see CLI_RUN_COMMAND_NAMES)
 * @param {object} [body]      Request body (targetOrg, alias, days, size, target, set)
 * @param {string} [fallbackOrg] Org used when body.targetOrg is absent (e.g. the
 *                             GUI session org). Empty string means "let the CLI
 *                             fall back to config.defaultOrg".
 * @returns {{ argv: string[], mutating: boolean } | { error: string }}
 */
export function buildCliRunArgv(command, body = {}, fallbackOrg = '') {
  const err = (message) => ({ error: message });

  // Resolve the optional `--org` flag. Returns null on an invalid alias.
  const orgArgs = () => {
    const org = body.targetOrg ?? fallbackOrg ?? '';
    if (org === '' || org === null || org === undefined) return [];
    if (!ORG_RE.test(String(org))) return null;
    return ['--org', String(org)];
  };

  switch (command) {
    case 'audit':
    case 'monitor': {
      const org = orgArgs();
      if (org === null) return err('Invalid targetOrg');
      return { argv: [command, 'all', ...org], mutating: false };
    }

    case 'scratch-create': {
      const argv = ['scratch', 'create'];
      if (body.alias !== undefined && body.alias !== null && body.alias !== '') {
        if (!ORG_RE.test(String(body.alias))) return err('Invalid alias');
        argv.push('--alias', String(body.alias));
      }
      if (body.days !== undefined && body.days !== null && body.days !== '') {
        const days = Number(body.days);
        if (!Number.isInteger(days) || days < 1 || days > 30) return err('Invalid days (must be an integer 1-30)');
        argv.push('--days', String(days));
      }
      return { argv, mutating: true };
    }

    case 'scratch-delete': {
      const target = body.target;
      if (typeof target !== 'string' || !ORG_RE.test(target)) return err('Invalid target');
      return { argv: ['scratch', 'delete', target, '--yes'], mutating: true };
    }

    case 'scratch-pool-fill': {
      const argv = ['scratch', 'pool', 'fill'];
      if (body.size !== undefined && body.size !== null && body.size !== '') {
        const size = Number(body.size);
        if (!Number.isInteger(size) || size < 1 || size > 100) return err('Invalid size (must be an integer 1-100)');
        argv.push('--size', String(size));
      }
      return { argv, mutating: true };
    }

    case 'data-export':
    case 'data-import':
    case 'data-delete': {
      const set = body.set;
      if (typeof set !== 'string' || !SET_RE.test(set)) return err('Invalid data set name');
      const org = orgArgs();
      if (org === null) return err('Invalid targetOrg');
      const sub = command.slice('data-'.length);
      const argv = ['data', sub, set, ...org];
      if (command === 'data-delete') argv.push('--yes');
      return { argv, mutating: true };
    }

    case 'docs-generate':
      return { argv: ['docs', 'generate'], mutating: true };

    case 'agent-test': {
      // Runs an Agentforce agent test (AiEvaluationDefinition) as a gate. Not
      // metadata-mutating; pass/fail is the CLI exit code.
      const spec = body.spec;
      if (typeof spec !== 'string' || !DEV_NAME_RE.test(spec)) return err('Invalid agent test spec (AiEvaluationDefinition API name)');
      const org = orgArgs();
      if (org === null) return err('Invalid targetOrg');
      return { argv: ['agent-test', '--spec', spec, ...org], mutating: false };
    }

    case 'retrofit': {
      // Retrieve a metadata set from a source org and (validate-only unless
      // execute) smart-deploy it to a target. `--execute` makes it mutating.
      const source = body.source;
      const target = body.target;
      if (typeof source !== 'string' || !ORG_RE.test(source)) return err('Invalid source org');
      if (typeof target !== 'string' || !ORG_RE.test(target)) return err('Invalid target org');
      const argv = ['retrofit', '--source', source, '--target', target];
      if (body.metadata !== undefined && body.metadata !== null && body.metadata !== '') {
        if (!METADATA_LIST_RE.test(String(body.metadata))) return err('Invalid metadata list (comma-separated types)');
        argv.push('--metadata', String(body.metadata));
      }
      const execute = body.execute === true || body.execute === 'true';
      if (execute) argv.push('--execute');
      return { argv, mutating: execute };
    }

    default:
      return err('Unknown command');
  }
}
