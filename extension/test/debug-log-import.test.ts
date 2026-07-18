import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture calls into the analyzer without opening the real profiler view.
// vi.mock is hoisted, so the spy must be created in a hoisted block too.
const { presentSpy } = vi.hoisted(() => ({
  presentSpy: vi.fn((_opts: unknown) => ({ close: vi.fn(), root: { nodeType: 1 } })),
}));
vi.mock('../ui/apex-log-analyzer.js', () => ({
  presentApexLogAnalyzer: presentSpy,
}));

import {
  _debugLogViewerTestApi,
  createDebugLogViewerFeature,
} from '../features/debug-log-viewer.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

const { importApexLogText, MAX_IMPORT_BYTES } = _debugLogViewerTestApi();

// A minimal-but-real Apex log: header line sets apiVersion, and the body carries
// recognised events — so the "clearly not a log" guard does NOT trip.
const SAMPLE_LOG = [
  '64.0 APEX_CODE,FINE;APEX_PROFILING,NONE;DB,INFO',
  '12:00:00.0 (1000)|EXECUTION_STARTED',
  '12:00:00.0 (2000)|CODE_UNIT_STARTED|[EXTERNAL]|MyClass.myMethod',
  '12:00:00.0 (3000)|USER_DEBUG|[5]|DEBUG|hello',
  '12:00:00.0 (4000)|CODE_UNIT_FINISHED|MyClass.myMethod',
  '12:00:00.0 (5000)|EXECUTION_FINISHED',
].join('\n');

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

function setSetupUrl(): void {
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
}

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    toolingQuery: vi.fn(async () => ({ records: [], size: 0, done: true })),
    apiGetText: vi.fn(async () => 'LOG BODY'),
    apiRequest: vi.fn(async () => null),
    query: vi.fn(async () => ({ records: [], done: true })),
    queryMore: vi.fn(async () => ({ records: [], done: true })),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function importInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('.sfdt-view-overlay input[type="file"]')!;
}

function toastText(): string {
  return document.querySelector('.sfdt-toast')?.textContent ?? '';
}

// happy-dom's File.text() may not be wired up; give the test a deterministic body.
function fileOf(text: string, name: string, sizeOverride?: number): File {
  const f = new File([text], name, { type: 'text/plain' });
  Object.defineProperty(f, 'text', { value: async () => text, configurable: true });
  if (sizeOverride !== undefined) {
    Object.defineProperty(f, 'size', { value: sizeOverride, configurable: true });
  }
  return f;
}

// Drive a file selection through the input's change handler.
function selectFile(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
}

describe('debug-log-viewer — importApexLogText (pure path)', () => {
  beforeEach(() => {
    clearBody();
    presentSpy.mockClear();
  });

  it('parses the text and opens the analyzer with the raw text + filename as title', () => {
    const handle = importApexLogText(SAMPLE_LOG, 'run.log', document);
    expect(handle).not.toBeNull();
    expect(presentSpy).toHaveBeenCalledTimes(1);
    const arg = presentSpy.mock.calls[0]![0] as {
      parsed: { apiVersion: string | null };
      rawText: string;
      title: string;
    };
    expect(arg.rawText).toBe(SAMPLE_LOG);
    expect(arg.title).toBe('run.log');
    // The parser ran (it's the single source of truth) — apiVersion came from it.
    expect(arg.parsed.apiVersion).toBe('64.0');
  });

  it('rejects an empty file with a friendly note and never opens the analyzer', () => {
    const handle = importApexLogText('   \n  ', 'empty.log', document);
    expect(handle).toBeNull();
    expect(presentSpy).not.toHaveBeenCalled();
    expect(toastText()).toContain('empty');
  });

  it('rejects a non-log file with a friendly note and never opens the analyzer', () => {
    const handle = importApexLogText('just some random notes, not a log', 'notes.txt', document);
    expect(handle).toBeNull();
    expect(presentSpy).not.toHaveBeenCalled();
    expect(toastText()).toContain("doesn't look like an Apex debug log");
  });
});

describe('debug-log-viewer — Import log action (no org)', () => {
  beforeEach(() => {
    clearBody();
    setSetupUrl();
    presentSpy.mockClear();
  });

  it('imports a picked file and opens the analyzer with ZERO Salesforce calls', async () => {
    const api = fakeApi();
    const feature = createDebugLogViewerFeature({ api });
    await feature.onActivate?.();
    await flush();

    selectFile(importInput(), fileOf(SAMPLE_LOG, 'local.log'));
    await flush();

    expect(presentSpy).toHaveBeenCalledTimes(1);
    const arg = presentSpy.mock.calls[0]![0] as { rawText: string; title: string };
    expect(arg.rawText).toBe(SAMPLE_LOG);
    expect(arg.title).toBe('local.log');
    // The import path is org-free: it fetches no body and issues no request.
    expect(api.apiGetText).not.toHaveBeenCalled();
    expect(api.apiRequest).not.toHaveBeenCalled();
  });

  it('rejects an oversized file with a visible message and does not open the analyzer', async () => {
    const api = fakeApi();
    const feature = createDebugLogViewerFeature({ api });
    await feature.onActivate?.();
    await flush();

    selectFile(importInput(), fileOf('x', 'huge.log', MAX_IMPORT_BYTES + 1));
    await flush();

    expect(presentSpy).not.toHaveBeenCalled();
    expect(toastText()).toContain('too large');
    expect(api.apiGetText).not.toHaveBeenCalled();
  });
});
