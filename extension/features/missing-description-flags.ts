import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { isFeatureEnabled, loadSettings, onSettingsChange, patchSettings } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
const ELEMENT_TYPE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['actionCalls', 'Action'],
  ['apexPluginCalls', 'Apex Action'],
  ['assignments', 'Assignment'],
  ['collectionProcessors', 'Collection Processor'],
  ['customErrors', 'Custom Error'],
  ['decisions', 'Decision'],
  ['loops', 'Loop'],
  ['recordCreates', 'Create Records'],
  ['recordDeletes', 'Delete Records'],
  ['recordLookups', 'Get Records'],
  ['recordRollbacks', 'Roll Back Records'],
  ['recordUpdates', 'Update Records'],
  ['screens', 'Screen'],
  ['subflows', 'Subflow'],
  ['transforms', 'Transform'],
  ['waits', 'Wait'],
  ['orchestratedStages', 'Stage'],
  ['stages', 'Stage'],
];
const RESOURCE_TYPE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['variables', 'Variable'],
  ['formulas', 'Formula'],
  ['constants', 'Constant'],
  ['textTemplates', 'Text Template'],
  ['choices', 'Choice'],
  ['dynamicChoiceSets', 'Dynamic Choice Set'],
];
export interface MissingItem {
  name: string;
  label: string;
  type: string;
  isResource: boolean;
  isFlow?: boolean;
}
export function findElementsWithoutDescriptions(
  metadata: Record<string, unknown> | null | undefined,
): MissingItem[] {
  if (!metadata) return [];
  const missing: MissingItem[] = [];
  for (const [key, type] of ELEMENT_TYPE_KEYS) {
    const items = metadata[key];
    if (!Array.isArray(items)) continue;
    for (const item of items as Array<Record<string, unknown>>) {
      const description = typeof item.description === 'string' ? item.description.trim() : '';
      if (!description) {
        missing.push({
          name: String(item.name ?? ''),
          label: String(item.label ?? item.name ?? ''),
          type,
          isResource: false,
        });
      }
      if ((key === 'orchestratedStages' || key === 'stages') && Array.isArray(item.stageSteps)) {
        for (const step of item.stageSteps as Array<Record<string, unknown>>) {
          const stepDesc = typeof step.description === 'string' ? step.description.trim() : '';
          if (!stepDesc) {
            missing.push({
              name: String(step.name ?? ''),
              label: String(step.label ?? step.name ?? ''),
              type: 'Step',
              isResource: false,
            });
          }
        }
      }
    }
  }
  for (const [key, type] of RESOURCE_TYPE_KEYS) {
    const items = metadata[key];
    if (!Array.isArray(items)) continue;
    for (const item of items as Array<Record<string, unknown>>) {
      const description = typeof item.description === 'string' ? item.description.trim() : '';
      if (!description) {
        missing.push({
          name: String(item.name ?? ''),
          label: String(item.name ?? ''),
          type,
          isResource: true,
        });
      }
    }
  }
  const flowDesc = typeof metadata.description === 'string' ? metadata.description.trim() : '';
  if (!flowDesc) {
    missing.push({ name: '__FLOW__', label: '__FLOW_LEVEL__', type: 'Flow', isResource: false, isFlow: true });
  }
  return missing;
}
function buildKeyIndex(missing: readonly MissingItem[]): Map<string, MissingItem> {
  const map = new Map<string, MissingItem>();
  for (const item of missing) {
    if (item.isFlow) continue;
    if (item.label) map.set(item.label.toLowerCase(), item);
    if (item.name && item.name.toLowerCase() !== item.label.toLowerCase()) {
      map.set(item.name.toLowerCase(), item);
    }
  }
  return map;
}
function flagCanvas(doc: Document, missing: readonly MissingItem[]): number {
  const index = buildKeyIndex(missing);
  let count = 0;
  const seen = new Set<string>();
  const spans = doc.querySelectorAll<HTMLSpanElement>(
    'span.text-element-label:not(.text-element-label-mask)',
  );
  for (const span of spans) {
    const text = (span.title || span.textContent || '').trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    const stripped = lower.replace(/^\d+\.\s*/, '');
    if (!index.has(lower) && !index.has(stripped)) continue;
    const card = span.closest('.element-card');
    if (!card) continue;
    const cardKey =
      card.closest('[data-key]')?.getAttribute('data-key') ??
      card.querySelector('.base-card')?.getAttribute('aria-label') ??
      text;
    if (seen.has(cardKey)) continue;
    if (card.querySelector('.sfut-desc-flag')) continue;
    const flag = doc.createElement('div');
    flag.className = 'sfut-desc-flag';
    flag.title = `"${text}" has no description`;
    flag.setAttribute('aria-label', `Warning: ${text} has no description`);
    flag.textContent = '⚠';
    flag.style.cssText =
      'position: absolute; top: 4px; right: 4px; color: #fe9339; font-size: 14px; z-index: 5;';
    (card as HTMLElement).style.position = 'relative';
    card.appendChild(flag);
    seen.add(cardKey);
    count += 1;
  }
  const flowMissing = missing.find((m) => m.isFlow);
  if (flowMissing) {
    const flowNameEl = doc.querySelector('.test-flow-name');
    const parent = flowNameEl?.parentElement;
    if (parent && !parent.querySelector('.sfut-desc-flag-flow')) {
      const flag = doc.createElement('span');
      flag.className = 'sfut-desc-flag-flow';
      flag.title = 'This flow has no description';
      flag.setAttribute('aria-label', 'Warning: This flow has no description');
      flag.textContent = ' ⚠';
      flag.style.cssText = 'color: #fe9339; margin-left: 4px;';
      parent.appendChild(flag);
      count += 1;
    }
  }
  return count;
}
function clearAllFlags(doc: Document): void {
  for (const cls of ['sfut-desc-flag', 'sfut-desc-flag-flow', 'sfut-desc-flag-toolbox']) {
    doc.querySelectorAll(`.${cls}`).forEach((el) => el.remove());
  }
}
export interface MissingDescriptionFlagsOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}
export function createMissingDescriptionFlagsFeature(
  options: MissingDescriptionFlagsOptions = {},
): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();
  let active = false;
  let missingItems: MissingItem[] = [];
  let observer: MutationObserver | null = null;
  let _settingsHookRegistered = false;
  let unsubscribeSettings: (() => void) | null = null;
  function startObserver(): void {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (active && missingItems.length > 0) requestAnimationFrame(() => flagCanvas(doc, missingItems));
    });
    if (doc.body) observer.observe(doc.body, { childList: true, subtree: true });
  }
  async function activate(): Promise<void> {
    const flowId = new URL(win.location.href).searchParams.get('flowId');
    if (!flowId) return;
    try {
      const record = (await api.getFlowMetadata(flowId)) as { Metadata?: Record<string, unknown> };
      const metadata = record?.Metadata;
      if (!metadata) return;
      missingItems = findElementsWithoutDescriptions(metadata);
      active = true;
      startObserver();
      flagCanvas(doc, missingItems);
    } catch (err) {
      console.warn('[SFUT missing-descriptions] activate failed:', err);
    }
  }
  function deactivate(): void {
    active = false;
    observer?.disconnect();
    observer = null;
    missingItems = [];
    clearAllFlags(doc);
  }
  return {
    manifest: {
      id: 'missing-descriptions',
      name: 'Show Missing Description Flags',
      contexts: [CONTEXTS.FLOW_BUILDER],
    },
    async init() {
      if (detectContext({ location: { href: win.location.href } }, doc) !== CONTEXTS.FLOW_BUILDER) {
        return;
      }
      const settings = await loadSettings();
      if (isFeatureEnabled(settings, 'missing-descriptions')) await activate();
      if (!_settingsHookRegistered) {
        _settingsHookRegistered = true;
        unsubscribeSettings = onSettingsChange(async (next) => {
          if (isFeatureEnabled(next, 'missing-descriptions') && !active) await activate();
          else if (!isFeatureEnabled(next, 'missing-descriptions') && active) deactivate();
        });
      }
    },
    async onActivate() {
      const settings = await loadSettings();
      const next = !isFeatureEnabled(settings, 'missing-descriptions');
      await patchSettings({ features: { ...settings.features, 'missing-descriptions': next } } as never);
      showToast(next ? 'Missing Description Flags enabled' : 'Missing Description Flags disabled', {
        kind: next ? 'success' : 'info',
        doc,
      });
    },
    async refresh() {
      if (!active) return;
      deactivate();
      await activate();
    },
    async teardown(): Promise<void> {
      deactivate();
      if (unsubscribeSettings) {
        unsubscribeSettings();
        unsubscribeSettings = null;
      }
      _settingsHookRegistered = false;
    },
  };
}
export function _missingDescriptionFlagsTestApi() {
  return { buildKeyIndex, flagCanvas, clearAllFlags };
}
