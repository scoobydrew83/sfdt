/**
 * Phase 2 of the API-version audit: the AI upgrade advisor behind
 * `sfdt versions --advise`. Explains the value, risks, and code changes of
 * moving components to a newer API version — GROUNDED by the curated
 * registry (src/lib/data/api-version-registry.json): the prompt instructs
 * the model that version facts may come only from the registry slice, and
 * that gaps must be answered "unknown — not in registry", never invented.
 *
 * Guardrails:
 * - read-only advisory: no agent loop, no writes — agentic providers get
 *   Read/Grep/Glob only (to inspect component source), the http provider
 *   gets the fully pre-gathered context and no tools;
 * - components are passed as untrusted JSON (the standard SYSTEM guard);
 * - redaction happens inside runAiPrompt;
 * - the component list is capped (token bounds) with the truncation stated
 *   in the prompt so the model never assumes it saw everything.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';

// Package-internal asset — resolve from the module location, never the CWD.
const REGISTRY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'data',
  'api-version-registry.json',
);

/** Max components serialized into the prompt; the rest is summarized. */
export const ADVISOR_COMPONENT_CAP = 100;

/** Load the curated registry (cached by Node's module-level state per process). */
export async function loadRegistry() {
  return fs.readJson(REGISTRY_PATH);
}

/**
 * The registry entries relevant to an upgrade: (from, to] — the versions the
 * components would pass through. Missing versions are simply absent (the
 * prompt handles gaps).
 */
export function sliceRegistry(registry, fromVersion, toVersion) {
  const out = {};
  for (let v = Math.floor(fromVersion) + 1; v <= Math.floor(toVersion); v++) {
    if (registry.versions[String(v)]) out[String(v)] = registry.versions[String(v)];
  }
  return out;
}

/**
 * Select the components worth advising on: anything below the target,
 * optionally filtered to one family. Uses the same component shape as
 * scanLocalApiVersions / fetchOrgApiVersions.
 */
export function selectComponents(components, targetVersion, typeFilter = null) {
  const FAMILY = {
    apex: ['ApexClass', 'ApexTrigger'],
    flow: ['Flow'],
    lwc: ['LWC', 'Aura'],
  };
  const allowed = typeFilter ? FAMILY[typeFilter] : null;
  return components.filter(
    (c) =>
      c.apiVersion != null &&
      c.apiVersion < targetVersion &&
      (!allowed || allowed.includes(c.type)),
  );
}

/**
 * Assemble the interpolation variables for the api-upgrade-advisor prompt.
 * Pure — the caller interpolates via prompts.js and runs runAiPrompt.
 */
export function buildAdvisorContext({ components, registry, targetVersion, sourceApiVersion }) {
  const oldest = Math.min(...components.map((c) => Math.floor(c.apiVersion)));
  const slice = sliceRegistry(registry, oldest, targetVersion);
  const capped = components.slice(0, ADVISOR_COMPONENT_CAP);
  const truncated = components.length - capped.length;
  return {
    targetVersion: String(targetVersion),
    sourceApiVersion: sourceApiVersion ?? 'not set',
    registrySlice: JSON.stringify(slice, null, 1),
    componentsJson:
      JSON.stringify(capped, null, 1) +
      (truncated > 0
        ? `\n// NOTE: ${truncated} additional component(s) omitted for size — this list is a sample, not the full set.`
        : ''),
  };
}
