# sfdt CLI — Development Guide

How to add or modify features in the sfdt CLI itself. Read this whenever someone says "sfdt should support X" or "can sfdt do Y."

## Architecture in one paragraph

Commands in `src/commands/` are thin: load config, set options, call `runScript()` or a lib function. Shell scripts in `scripts/` do the real work and read everything from `SFDT_`-prefixed env vars (never positional args). Shared Node.js logic lives in `src/lib/`. New config keys must be added to `src/templates/sfdt.config.json` first — `sfdt init` reads this template directly.

---

## Adding a new command

### 1. Create the command file

```js
// src/commands/<name>.js
import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';

export function register<Name>Command(program) {
  program
    .command('<name>')
    .description('What it does')
    .option('--org <alias>', 'Target org alias')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        await runScript('category/<name>.sh', config, {
          cwd: config._projectRoot,
          env: { SFDT_TARGET_ORG: options.org || config.defaultOrg || '' },
        });
        print.success('Done.');
      } catch (err) {
        print.error(`<name> failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}
```

### 2. Register in src/cli.js

Add two lines:

```js
// at top with other imports:
import { register<Name>Command } from './commands/<name>.js';

// inside createCli(), with other registerXxx calls:
register<Name>Command(program);
```

### 3. Rules for command files

- **Thin**: load config, validate options, call `runScript()` or `src/lib/`. No business logic.
- **Error handling**: catch errors, set `process.exitCode = resolveExitCode(err)`, return — don't `process.exit()`.
- **AI features**: guard with `isAiAvailable(config)` from `src/lib/ai.js`. If unavailable, call `print.warn(aiUnavailableMessage(config))` and return.
- **Interactive checks**: pass `interactive: !options.nonInteractive` to `runScript()` when the command has a `--non-interactive` flag.

---

## Adding a shell script

### Location

```
scripts/
  core/       # deploy, test, release, pull
  new/        # preflight, rollback, smoke, drift
  quality/    # code-analyzer, test-analyzer
  utils/      # shared helper functions
```

### Rules

- **De-parameterized**: read `SFDT_` env vars, never positional arguments.
- **POSIX-compatible** where possible; bash 4.0+ features are acceptable.
- **Guard variables**: use `${VAR:-default}` for optional vars.
- **Exit codes**: exit 1 on failure so `runScript()` throws correctly.

```bash
#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${SFDT_PROJECT_ROOT:-.}"
TARGET_ORG="${SFDT_TARGET_ORG:-}"

if [[ -z "$TARGET_ORG" ]]; then
  echo "Error: SFDT_TARGET_ORG is required" >&2
  exit 1
fi
```

---

## Adding a config key

### Step 1 — Add to the template (required first)

`src/templates/sfdt.config.json` is the source of truth. `sfdt init` reads it directly via `fs.readJson`. Add the key with its default value here.

### Step 2 — Add a default in config.js (if needed)

`src/lib/config.js` enriches config at load time. If the key needs a computed default (e.g., derived from `sfdx-project.json`), add it there.

### Step 3 — Expose as SFDT_ env var (if shell scripts need it)

If shell scripts need the new key, add it to `buildScriptEnv()` in `src/lib/script-runner.js`:

```js
env.SFDT_MY_NEW_KEY = config.myNewKey || 'default';
```

**Then immediately update the CLAUDE.md env var table** — both must stay in sync or the table becomes wrong documentation. The table lives in the `SFDT_ Environment Variables` section of `CLAUDE.md`.

---

## Adding a SFDT_ environment variable

Two changes, always together:

1. **`src/lib/script-runner.js`** — add to `buildScriptEnv()`:
   ```js
   env.SFDT_MY_VAR = config.myKey || '';
   ```

2. **`CLAUDE.md`** — add a row to the env var table:
   ```markdown
   | `SFDT_MY_VAR` | `config.myKey` |
   ```

Missing either one means the table lies. Do both before committing.

---

## Adding a lib module

Drop a new file in `src/lib/<name>.js`. Export named functions. Import in command files as needed. Don't add a lib for single-use logic — only extract when two or more commands share it.

---

## Writing tests

```
test/
  commands/     # command registration + action tests
  lib/          # unit tests for src/lib/ modules
  scripts/      # (rare) shell script integration tests
```

**Mock pattern** (vitest):

```js
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('execa');
vi.mock('fs-extra');
vi.mock('inquirer');

import { execa } from 'execa';

describe('myCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls the right script', async () => {
    execa.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    // ...
  });
});
```

**What to test per change type**:

| Change | Test |
|--------|------|
| New command | Registration (command appears in program), happy-path action, error path sets exitCode |
| New shell script | Tested via its command's action mock; integration tests rare |
| New config key | `loadConfig()` returns correct default when key absent |
| New env var | `buildScriptEnv()` unit test — correct key and value |

---

## Pre-commit checklist

Before marking any CLI change complete:

- [ ] Command registered in `src/cli.js`
- [ ] Shell script de-parameterized (no positional args)
- [ ] Config key added to `src/templates/sfdt.config.json` if applicable
- [ ] `buildScriptEnv()` updated if new `SFDT_` var added
- [ ] CLAUDE.md env var table updated if new `SFDT_` var added
- [ ] Tests written or updated
- [ ] `npm test` passes
- [ ] `npm run lint` clean
- [ ] `references/commands.md` updated if new/changed command
- [ ] `references/config.md` updated if new config key

---

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Positional args in shell script | Use `SFDT_` env var instead |
| Config key with no template entry | Add to `src/templates/sfdt.config.json` first |
| New `SFDT_` var without CLAUDE.md update | Update the table — they must stay in sync |
| Logic in command file | Move to `src/lib/` or shell script |
| Using `process.exit()` | Use `process.exitCode =` and `return` instead |
| Forgetting `resolveExitCode(err)` | Always use it — raw exit codes lose context |
| AI command with no availability check | Guard with `isAiAvailable(config)` |
