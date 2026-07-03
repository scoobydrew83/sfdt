import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAiAssistantFeature, _aiAssistantTestApi } from '../features/ai-assistant.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';
import type { PromptLibrary, ResolvedPrompt } from '@sfdt/flow-core';

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

function setFlowUrl(flowId = '301xx0000000001'): void {
  window.history.replaceState(
    {},
    '',
    `https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=${flowId}`,
  );
}

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    getFlowMetadata: vi.fn(async () => ({ Metadata: { label: 'Demo', start: {} } })),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

const PROMPTS: ResolvedPrompt[] = [
  { id: 'doc', title: 'Document Flow', description: 'Writes docs', body: 'DOC:' } as unknown as ResolvedPrompt,
  { id: 'review', title: 'Review Flow', description: 'Reviews', body: 'REVIEW:' } as unknown as ResolvedPrompt,
];

function fakeLibrary(overrides: Record<string, unknown> = {}): PromptLibrary {
  return {
    load: vi.fn(async () => {}),
    getEnabled: vi.fn(() => PROMPTS),
    getDefaultPromptId: vi.fn(() => 'review'),
    getById: vi.fn((id: string) => PROMPTS.find((p) => p.id === id) ?? null),
    assemble: vi.fn((id: string, json: string) => `PROMPT[${id}]\n${json}`),
    ...overrides,
  } as unknown as PromptLibrary;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  clearBody();
  setFlowUrl();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
    writable: true,
  });
});

describe('ai-assistant — test seam', () => {
  it('pins the legacy storage keys (migration safety)', () => {
    const keys = _aiAssistantTestApi();
    expect(keys.STORAGE_KEY_DISABLED).toBe('aiPromptLibrary.disabledStandardIds');
    expect(keys.STORAGE_KEY_CUSTOMS).toBe('aiPromptLibrary.customPrompts');
    expect(keys.STORAGE_KEY_DEFAULT).toBe('aiPromptLibrary.defaultPromptId');
  });
});

describe('ai-assistant — manifest', () => {
  it('targets the Flow Builder context', () => {
    const feature = createAiAssistantFeature({ api: fakeApi(), library: fakeLibrary() });
    expect(feature.manifest.id).toBe('ai-assistant');
    expect(feature.manifest.contexts).toContain('flow_builder');
  });
});

describe('ai-assistant — panel toggle', () => {
  it('onActivate opens the panel, then closes it on a second activation', async () => {
    const feature = createAiAssistantFeature({ api: fakeApi(), library: fakeLibrary() });
    feature.onActivate?.();
    await flush();
    expect(document.querySelector('.sfdt-view-overlay')).not.toBeNull();
    feature.onActivate?.();
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
  });

  it('the close button removes the panel', async () => {
    const feature = createAiAssistantFeature({ api: fakeApi(), library: fakeLibrary() });
    feature.onActivate?.();
    await flush();
    const closeBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '×')!;
    closeBtn.click();
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
  });

  it('Escape key closes the panel', async () => {
    const feature = createAiAssistantFeature({ api: fakeApi(), library: fakeLibrary() });
    feature.onActivate?.();
    await flush();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
  });
});

describe('ai-assistant — metadata loading branches', () => {
  it('shows a message when the URL has no flowId', async () => {
    window.history.replaceState({}, '', 'https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app');
    const api = fakeApi();
    const feature = createAiAssistantFeature({ api, library: fakeLibrary() });
    feature.onActivate?.();
    await flush();
    expect(document.querySelector('.sfdt-ai-panel-body')?.textContent).toContain(
      'Could not determine Flow ID',
    );
    expect(api.getFlowMetadata).not.toHaveBeenCalled();
  });

  it('shows a message when the Flow has no metadata', async () => {
    const api = fakeApi({ getFlowMetadata: vi.fn(async () => ({})) as SalesforceApiClient['getFlowMetadata'] });
    const feature = createAiAssistantFeature({ api, library: fakeLibrary() });
    feature.onActivate?.();
    await flush();
    expect(document.querySelector('.sfdt-ai-panel-body')?.textContent).toContain(
      'No metadata returned',
    );
  });

  it('surfaces an error when metadata fetch throws', async () => {
    const api = fakeApi({
      getFlowMetadata: vi.fn(async () => {
        throw new Error('403 Forbidden');
      }) as SalesforceApiClient['getFlowMetadata'],
    });
    const feature = createAiAssistantFeature({ api, library: fakeLibrary() });
    feature.onActivate?.();
    await flush();
    expect(document.querySelector('.sfdt-ai-panel-body')?.textContent).toContain('Error: 403 Forbidden');
  });
});

describe('ai-assistant — populated panel', () => {
  it('renders one option per enabled prompt with the default pre-selected', async () => {
    const feature = createAiAssistantFeature({ api: fakeApi(), library: fakeLibrary() });
    feature.onActivate?.();
    await flush();
    const select = document.querySelector<HTMLSelectElement>('.sfdt-ai-panel-body select')!;
    const options = select.querySelectorAll('option');
    expect(options).toHaveLength(2);
    expect(select.value).toBe('review'); // default prompt id
  });

  it('updates the description when the prompt selection changes', async () => {
    const library = fakeLibrary();
    const feature = createAiAssistantFeature({ api: fakeApi(), library });
    feature.onActivate?.();
    await flush();
    const select = document.querySelector<HTMLSelectElement>('.sfdt-ai-panel-body select')!;
    // Initial description reflects the default ('review').
    const body = document.querySelector('.sfdt-ai-panel-body')!;
    expect(body.textContent).toContain('Reviews');
    select.value = 'doc';
    select.dispatchEvent(new Event('change'));
    expect(body.textContent).toContain('Writes docs');
  });

  it('Copy Raw copies the raw metadata JSON to the clipboard', async () => {
    const feature = createAiAssistantFeature({ api: fakeApi(), library: fakeLibrary() });
    feature.onActivate?.();
    await flush();
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '📋 Copy Raw')!;
    btn.click();
    await flush();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(JSON.stringify({ label: 'Demo', start: {} }, null, 2));
  });

  it('Copy Prompt assembles via the library and copies the result', async () => {
    const library = fakeLibrary();
    const feature = createAiAssistantFeature({ api: fakeApi(), library });
    feature.onActivate?.();
    await flush();
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '📋 Copy Prompt')!;
    btn.click();
    await flush();
    expect(library.assemble).toHaveBeenCalledWith('review', expect.any(String));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('PROMPT[review]'));
  });

  it('renders all four action buttons including Run via sfdt', async () => {
    const feature = createAiAssistantFeature({ api: fakeApi(), library: fakeLibrary() });
    feature.onActivate?.();
    await flush();
    const labels = Array.from(document.querySelectorAll('.sfdt-ai-panel-body button')).map((b) => b.textContent);
    expect(labels).toEqual(['📋 Copy Raw', '📋 Copy Clean', '📋 Copy Prompt', '🚀 Run via sfdt']);
  });
});

describe('ai-assistant — Run via sfdt', () => {
  function fakeBridge(response: unknown) {
    const call = vi.fn(async (..._args: unknown[]) => response);
    return { bridge: { call }, factory: async () => ({ call }) };
  }

  async function openAndRun(bridgeFactory: () => Promise<{ call: ReturnType<typeof vi.fn> }>) {
    const feature = createAiAssistantFeature({
      api: fakeApi(),
      library: fakeLibrary(),
      bridgeFactory: bridgeFactory as never,
    });
    feature.onActivate?.();
    await flush();
    const runBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === '🚀 Run via sfdt',
    ) as HTMLButtonElement;
    runBtn.click();
    await flush();
    return runBtn;
  }

  it('renders the AI response text and provider on success', async () => {
    const { bridge, factory } = fakeBridge({
      ok: true,
      data: { response: 'The flow looks solid.\nOne warning.', provider: 'claude' },
    });
    await openAndRun(factory);

    const result = document.querySelector('.sfdt-ai-result')!;
    expect(result.textContent).toContain('AI response (claude)');
    expect(result.querySelector('pre')!.textContent).toBe('The flow looks solid.\nOne warning.');
    expect(bridge.call).toHaveBeenCalledWith(
      { kind: 'ai', prompt: expect.stringContaining('PROMPT[review]') },
      { timeoutMs: expect.any(Number) },
    );
    // AI runs exceed the 8s default bridge timeout — the long-running one must be used.
    const timeoutMs = (bridge.call.mock.calls[0]![1] as { timeoutMs: number }).timeoutMs;
    expect(timeoutMs).toBeGreaterThanOrEqual(60000);
  });

  it('Copy response copies the rendered response', async () => {
    const { factory } = fakeBridge({ ok: true, data: { response: 'answer text', provider: 'claude' } });
    await openAndRun(factory);
    const copyBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === '📋 Copy response',
    )!;
    copyBtn.click();
    await flush();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('answer text');
  });

  it('renders a bridge error in the result area on failure', async () => {
    const { factory } = fakeBridge({ ok: false, error: 'Bridge offline', code: 'BRIDGE_OFFLINE' });
    await openAndRun(factory);
    const result = document.querySelector('.sfdt-ai-result')!;
    expect(result.textContent).toContain('Bridge: Bridge offline');
    expect(result.querySelector('pre')).toBeNull();
  });

  it('disables the run button while the call is in flight and re-enables after', async () => {
    let release!: (value: unknown) => void;
    const call = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const feature = createAiAssistantFeature({
      api: fakeApi(),
      library: fakeLibrary(),
      bridgeFactory: (async () => ({ call })) as never,
    });
    feature.onActivate?.();
    await flush();
    const runBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === '🚀 Run via sfdt',
    ) as HTMLButtonElement;
    runBtn.click();
    await flush();
    expect(runBtn.disabled).toBe(true);
    expect(runBtn.textContent).toBe('⏳ Running…');
    release({ ok: true, data: { response: 'done', provider: 'claude' } });
    await flush();
    expect(runBtn.disabled).toBe(false);
    expect(runBtn.textContent).toBe('🚀 Run via sfdt');
  });

  it('a second run replaces the previous result', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { response: 'first', provider: 'claude' } })
      .mockResolvedValueOnce({ ok: true, data: { response: 'second', provider: 'claude' } });
    const feature = createAiAssistantFeature({
      api: fakeApi(),
      library: fakeLibrary(),
      bridgeFactory: (async () => ({ call })) as never,
    });
    feature.onActivate?.();
    await flush();
    const runBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === '🚀 Run via sfdt',
    ) as HTMLButtonElement;
    runBtn.click();
    await flush();
    runBtn.click();
    await flush();
    const pres = document.querySelectorAll('.sfdt-ai-result pre');
    expect(pres).toHaveLength(1);
    expect(pres[0]!.textContent).toBe('second');
  });
});
