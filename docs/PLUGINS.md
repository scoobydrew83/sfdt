# SFDT Plugin Contract

SFDT plugins extend the CLI with new subcommands using Commander.js. A plugin is a Node.js ESM module that exports a `register` function.

## Required Export

Every plugin must export exactly one function:

```js
/**
 * @param {import('commander').Command} program
 */
export function register(program) {
  program
    .command('my-command')
    .description('What this command does')
    .action(async () => {
      // implementation
    });
}
```

The `program` argument is the root Commander instance. Call `.command()` on it to add subcommands. Do not call `program.parse()` or `program.parseAsync()` — the CLI entry point handles that after all plugins load.

## Loading Sources

Plugins are loaded in this order before CLI argument parsing:

### 1. Explicit packages (`config.plugins[]`)

List package names in `.sfdt/config.json`:

```json
{
  "plugins": ["sfdt-plugin-my-thing", "@myorg/sfdt-plugin-deploy-ext"]
}
```

Packages are resolved from the **project's** `node_modules/`, not the global sfdt install.

### 2. Auto-discovered packages (`pluginOptions.autoDiscover`)

Opt in by setting `pluginOptions.autoDiscover: true` in `.sfdt/config.json`. When enabled, sfdt scans `node_modules/` for packages whose name starts with `sfdt-plugin-` (including scoped: `@org/sfdt-plugin-*`) and loads them automatically.

**Auto-discovery is off by default.** It executes arbitrary project-local code before CLI parsing — only enable it when you control the packages in your project.

### 3. Local files (`.sfdt/plugins/*.js`)

Also requires `pluginOptions.autoDiscover: true`. Any `.js` or `.mjs` file in `.sfdt/plugins/` is loaded as a local plugin.

```
.sfdt/
  plugins/
    custom-deploy.js   ← loaded automatically when autoDiscover is true
```

## Minimal Example

```js
// sfdt-plugin-hello/index.js
export function register(program) {
  program
    .command('hello')
    .description('Print a greeting')
    .option('--name <name>', 'Who to greet', 'world')
    .action((options) => {
      console.log(`Hello, ${options.name}!`);
    });
}
```

Install: `npm install sfdt-plugin-hello` in your Salesforce project, then add `"sfdt-plugin-hello"` to `config.plugins[]`.

## Error Handling

Plugin failures are **warnings, never crashes**. If a plugin throws during load, sfdt prints a warning and continues:

```
⚠  Failed to load plugin "sfdt-plugin-bad": Cannot find module 'missing-dep'
```

The CLI remains fully functional. Explicit plugins (`config.plugins[]`) that fail to load do not abort startup.

## Package Naming

- npm packages: name must start with `sfdt-plugin-` for auto-discovery
- Scoped packages: `@yourorg/sfdt-plugin-name` also qualifies for auto-discovery
- Explicit packages: any name works when listed in `config.plugins[]`
