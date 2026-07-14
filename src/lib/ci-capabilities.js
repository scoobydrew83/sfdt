/**
 * Canonical registry of what `sfdt ci init` supports — providers, workflow
 * types, auth methods, and per-provider runner modes. Single source of truth
 * consumed by the ci command (option help + validation), the CI template
 * renderer, tests, and `tools/generate-catalogs.mjs` (ci-capabilities.json).
 *
 * Adding a provider/type/auth/runner means changing it HERE (plus the template
 * assets), never re-declaring the list at a call site.
 */

export const CI_PROVIDERS = ['github', 'gitlab', 'azure', 'bitbucket'];
export const CI_TYPES = ['monitor', 'deploy', 'release', 'scratch'];
export const AUTH_METHODS = ['sfdx-url', 'jwt'];
export const RUNNERS = ['npx', 'docker', 'action'];

// Providers whose jobs run in a user-chosen container image, where the official
// sfdt image (sf CLI + sfdt preinstalled) can replace the per-run npm installs.
export const DOCKER_RUNNER_PROVIDERS = ['gitlab', 'bitbucket'];

// Scratch pipelines drive raw `sf` commands with their own cleanup semantics,
// which the single-command action deliberately does not wrap.
export const ACTION_RUNNER_TYPES = ['monitor', 'deploy', 'release'];

/** Runner modes valid for each provider (derived from the constants above). */
export const CI_RUNNERS = Object.fromEntries(
  CI_PROVIDERS.map((p) => [
    p,
    [
      'npx',
      ...(DOCKER_RUNNER_PROVIDERS.includes(p) ? ['docker'] : []),
      ...(p === 'github' ? ['action'] : []),
    ],
  ]),
);
