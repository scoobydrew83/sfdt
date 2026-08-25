import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AUTO_REFRESH_INTERVAL_MS,
  buildDeployRequestQuery,
  createDeployStatusFeature,
  formatCountTriple,
  formatDeployDuration,
  formatDeployWhen,
  isDeployQueryRejected,
  isInFlight,
  shapeComponentFailures,
  shapeDeployRows,
  shouldFetchComponentErrors,
  statusPillClass,
  type RawDeployRequest,
} from '../features/deploy-status.js';
import { SalesforceRestError, type SalesforceApiClient } from '../lib/salesforce-api.js';

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

function setSetupUrl(): void {
  window.history.replaceState(
    {},
    '',
    'https://x.lightning.force.com/lightning/setup/SetupOneHome/home',
  );
}

function setNonSalesforceUrl(): void {
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/page/home');
}

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    toolingQuery: vi.fn(async () => ({ records: [], size: 0, done: true })),
    apiSoap: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

function rawRow(overrides: Partial<RawDeployRequest> = {}): RawDeployRequest {
  return {
    Id: '0Af000000000001',
    Status: 'Succeeded',
    StartDate: '2026-06-22T12:00:00.000Z',
    CompletedDate: '2026-06-22T12:00:05.000Z',
    NumberComponentsDeployed: 3,
    NumberComponentErrors: 0,
    NumberComponentsTotal: 3,
    NumberTestsCompleted: 0,
    NumberTestErrors: 0,
    NumberTestsTotal: 0,
    CreatedBy: { Name: 'Ada Lovelace' },
    CheckOnly: false,
    ErrorMessage: null,
    StateDetail: null,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('deploy-status — buildDeployRequestQuery', () => {
  it('queries DeployRequest with CLI fields plus id, counts, check-only, and messages', () => {
    const q = buildDeployRequestQuery(25);
    expect(q).toContain('FROM DeployRequest');
    expect(q).toContain('ORDER BY CompletedDate DESC NULLS LAST');
    expect(q).toContain('LIMIT 25');
    expect(q).toContain('Id');
    expect(q).toContain('Status');
    expect(q).toContain('StartDate');
    expect(q).toContain('CompletedDate');
    expect(q).toContain('NumberComponentErrors');
    expect(q).toContain('NumberComponentsDeployed');
    expect(q).toContain('NumberComponentsTotal');
    expect(q).toContain('NumberTestsCompleted');
    expect(q).toContain('NumberTestErrors');
    expect(q).toContain('NumberTestsTotal');
    expect(q).toContain('CreatedBy.Name');
    expect(q).toContain('CheckOnly');
    expect(q).toContain('ErrorMessage');
    expect(q).toContain('StateDetail');
    expect(q).not.toContain('WHERE');
  });

  it('clamps the limit into a sane range', () => {
    expect(buildDeployRequestQuery(0)).toContain('LIMIT 1');
    expect(buildDeployRequestQuery(9999)).toContain('LIMIT 200');
    expect(buildDeployRequestQuery(10.7)).toContain('LIMIT 10');
  });
});

describe('deploy-status — shapeDeployRows', () => {
  it('maps Tooling fields and skips rows without an Id', () => {
    const rows = shapeDeployRows([
      rawRow(),
      { Status: 'Failed' },
      rawRow({ Id: '0Af000000000002', Status: 'Failed', CheckOnly: true, CreatedBy: null }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.createdBy).toBe('Ada Lovelace');
    expect(rows[0]?.checkOnly).toBe(false);
    expect(rows[1]?.id).toBe('0Af000000000002');
    expect(rows[1]?.checkOnly).toBe(true);
    expect(rows[1]?.createdBy).toBe('—');
  });
});

describe('deploy-status — isInFlight / statusPillClass / counts', () => {
  it('treats Pending, InProgress, and Canceling as in-flight', () => {
    expect(isInFlight('Pending')).toBe(true);
    expect(isInFlight('InProgress')).toBe(true);
    expect(isInFlight('Canceling')).toBe(true);
    expect(isInFlight('Succeeded')).toBe(false);
    expect(isInFlight('Failed')).toBe(false);
    expect(isInFlight('Canceled')).toBe(false);
    expect(isInFlight(null)).toBe(false);
  });

  it('maps status onto pill classes', () => {
    expect(statusPillClass('Succeeded')).toBe('sfdt-pill sfdt-success');
    expect(statusPillClass('Failed')).toBe('sfdt-pill sfdt-error');
    expect(statusPillClass('InProgress')).toBe('sfdt-pill sfdt-warning');
    expect(statusPillClass('Canceled')).toBe('sfdt-pill');
  });

  it('formats a count triple, omitting zeros and pluralising errors', () => {
    expect(formatCountTriple(0, 0, 0)).toBe('—');
    expect(formatCountTriple(3, 3, 0)).toBe('3 / 3');
    expect(formatCountTriple(2, 4, 1)).toBe('2 / 4 (1 error)');
    expect(formatCountTriple(2, 4, 2)).toBe('2 / 4 (2 errors)');
  });
});

describe('deploy-status — formatDeployWhen / formatDeployDuration', () => {
  it('formats a timestamp, falling back for missing or invalid values', () => {
    const iso = '2026-06-22T12:00:00.000Z';
    expect(formatDeployWhen(iso)).toBe(new Date(iso).toLocaleString());
    expect(formatDeployWhen(null)).toBe('—');
    expect(formatDeployWhen('')).toBe('—');
    expect(formatDeployWhen('not-a-date')).toBe('not-a-date');
  });

  it('formats a duration between two timestamps', () => {
    expect(formatDeployDuration('2026-06-22T12:00:00.000Z', '2026-06-22T12:00:05.000Z')).toBe(
      '5s',
    );
    expect(formatDeployDuration('2026-06-22T12:00:00.000Z', '2026-06-22T12:02:03.000Z')).toBe(
      '2m 3s',
    );
    expect(formatDeployDuration('2026-06-22T12:00:00.000Z', '2026-06-22T12:02:00.000Z')).toBe(
      '2m',
    );
    expect(formatDeployDuration(null, '2026-06-22T12:00:05.000Z')).toBe('—');
    expect(formatDeployDuration('2026-06-22T12:00:05.000Z', '2026-06-22T12:00:00.000Z')).toBe(
      '—',
    );
  });
});

describe('deploy-status — isDeployQueryRejected', () => {
  it('recognises INVALID_TYPE and the filter-required refusal', () => {
    expect(isDeployQueryRejected(new Error('INVALID_TYPE: sObject type DeployRequest'))).toBe(
      true,
    );
    expect(isDeployQueryRejected(new Error('DeployRequest requires a filter'))).toBe(true);
    expect(
      isDeployQueryRejected(
        new SalesforceRestError('Salesforce GET failed (HTTP 400)', 400, [
          {
            message: "sObject type 'DeployRequest' is not supported.",
            errorCode: 'INVALID_TYPE',
            fields: [],
          },
        ]),
      ),
    ).toBe(true);
    expect(isDeployQueryRejected(new Error('boom'))).toBe(false);
    expect(isDeployQueryRejected(null)).toBe(false);
  });
});

describe('deploy-status — shapeComponentFailures', () => {
  it('reads a SOAP envelope, a details object, or a single failure', () => {
    const one = { componentType: 'ApexClass', fullName: 'Foo', problem: 'Missing }', lineNumber: 12 };
    expect(shapeComponentFailures({ details: { componentFailures: one } })).toEqual([
      { componentType: 'ApexClass', fullName: 'Foo', problem: 'Missing }', lineNumber: '12' },
    ]);
    expect(
      shapeComponentFailures({
        componentFailures: [one, { componentType: 'ApexPage', fullName: 'Bar', problem: 'bad' }],
      }),
    ).toHaveLength(2);
    expect(shapeComponentFailures(null)).toEqual([]);
  });
});

describe('deploy-status — shouldFetchComponentErrors', () => {
  it('fetches SOAP details for failed or partial deploys, not clean successes', () => {
    const ok = shapeDeployRows([rawRow()])[0]!;
    const failed = shapeDeployRows([rawRow({ Status: 'Failed' })])[0]!;
    const partial = shapeDeployRows([rawRow({ Status: 'SucceededPartial' })])[0]!;
    const errors = shapeDeployRows([rawRow({ Status: 'Succeeded', NumberComponentErrors: 2 })])[0]!;
    expect(shouldFetchComponentErrors(ok)).toBe(false);
    expect(shouldFetchComponentErrors(failed)).toBe(true);
    expect(shouldFetchComponentErrors(partial)).toBe(true);
    expect(shouldFetchComponentErrors(errors)).toBe(true);
  });
});

describe('deploy-status — onActivate context gate', () => {
  beforeEach(() => clearBody());

  it('warns and does not open outside a Salesforce page', async () => {
    setNonSalesforceUrl();
    const api = fakeApi();
    const feature = createDeployStatusFeature({ api });
    await feature.onActivate?.();
    await flush();
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
    expect(api.toolingQuery).not.toHaveBeenCalled();
    expect(document.querySelector('.sfdt-toast')?.textContent).toContain('deployment status');
  });
});

describe('deploy-status — list', () => {
  beforeEach(() => {
    clearBody();
    setSetupUrl();
  });

  it('renders recent deployments from the Tooling query', async () => {
    const toolingQuery = vi.fn(async (_soql: string) => ({
      records: [
        rawRow(),
        rawRow({
          Id: '0Af000000000002',
          Status: 'Failed',
          CreatedBy: { Name: 'Grace Hopper' },
          CheckOnly: true,
          NumberComponentErrors: 2,
          NumberComponentsDeployed: 1,
          NumberComponentsTotal: 3,
        }),
      ],
      size: 2,
      done: true,
    }));
    const feature = createDeployStatusFeature({
      api: fakeApi({
        toolingQuery: toolingQuery as unknown as SalesforceApiClient['toolingQuery'],
      }),
    });
    await feature.onActivate?.();
    await flush();

    expect(toolingQuery).toHaveBeenCalledTimes(1);
    const q = String(toolingQuery.mock.calls[0]![0]);
    expect(q).toContain('FROM DeployRequest');
    expect(q).not.toContain('WHERE');

    const body = document.body.textContent ?? '';
    expect(body).toContain('2 deployments');
    expect(body).toContain('Ada Lovelace');
    expect(body).toContain('Grace Hopper');
    expect(body).toContain('Failed');
    expect(body).toContain('Validate');
    expect(body).toContain('1 / 3 (2 errors)');
    expect(document.querySelector('.sfdt-view-overlay')).not.toBeNull();
  });

  it('the refresh button re-runs the query', async () => {
    const toolingQuery = vi.fn(async () => ({
      records: [rawRow()],
      size: 1,
      done: true,
    }));
    const feature = createDeployStatusFeature({
      api: fakeApi({
        toolingQuery: toolingQuery as unknown as SalesforceApiClient['toolingQuery'],
      }),
    });
    await feature.onActivate?.();
    await flush();
    expect(toolingQuery).toHaveBeenCalledTimes(1);
    document.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
    await flush();
    expect(toolingQuery).toHaveBeenCalledTimes(2);
    await feature.teardown?.();
  });

  it('filters the loaded rows without re-querying', async () => {
    const toolingQuery = vi.fn(async () => ({
      records: [
        rawRow(),
        rawRow({ Id: '0Af000000000002', CreatedBy: { Name: 'Grace Hopper' } }),
      ],
      size: 2,
      done: true,
    }));
    await createDeployStatusFeature({
      api: fakeApi({
        toolingQuery: toolingQuery as unknown as SalesforceApiClient['toolingQuery'],
      }),
    }).onActivate?.();
    await flush();
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Filter deployments"]')!;
    input.value = 'grace';
    input.dispatchEvent(new Event('input'));
    expect(toolingQuery).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('1 of 2 deployments');
    expect(document.body.textContent).toContain('Grace Hopper');
    expect(document.body.textContent).not.toContain('Ada Lovelace');
  });
});

describe('deploy-status — warn-not-error degrade', () => {
  beforeEach(() => {
    clearBody();
    setSetupUrl();
  });

  async function activateWithThrow(err: unknown): Promise<void> {
    const feature = createDeployStatusFeature({
      api: fakeApi({
        toolingQuery: vi.fn(async () => {
          throw err;
        }) as unknown as SalesforceApiClient['toolingQuery'],
      }),
    });
    await feature.onActivate?.();
    await flush();
  }

  it('INVALID_TYPE becomes a warn callout, not an error console, and the view stays open', async () => {
    await activateWithThrow(
      new SalesforceRestError('INVALID_TYPE: sObject type DeployRequest is not supported.', 400, [
        {
          message: "sObject type 'DeployRequest' is not supported.",
          errorCode: 'INVALID_TYPE',
          fields: [],
        },
      ]),
    );
    const callout = document.querySelector('.sfdt-callout.sfdt-warn');
    expect(callout?.getAttribute('role')).toBe('status');
    expect(callout?.textContent).toContain('Deployment history unavailable in this org');
    expect(callout?.textContent).toContain('INVALID_TYPE');
    expect(document.querySelector('.sfdt-console.sfdt-error')).toBeNull();
    expect(document.querySelector('.sfdt-view-overlay')).not.toBeNull();
  });

  it('a DeployRequest filter refusal degrades the same way', async () => {
    await activateWithThrow(new Error('DeployRequest requires a filter'));
    const callout = document.querySelector('.sfdt-callout.sfdt-warn');
    expect(callout?.textContent).toContain('DeployRequest requires a filter');
    expect(document.querySelector('.sfdt-console.sfdt-error')).toBeNull();
    expect(document.querySelector('.sfdt-view-overlay')).not.toBeNull();
  });
});

describe('deploy-status — detail / component errors', () => {
  beforeEach(() => {
    clearBody();
    setSetupUrl();
  });

  it('shows SOAP componentFailures for a failed deploy', async () => {
    const apiSoap = vi.fn(async () => ({
      details: {
        componentFailures: {
          componentType: 'ApexClass',
          fullName: 'Foo',
          problem: 'Missing }',
          lineNumber: 12,
        },
      },
    }));
    const feature = createDeployStatusFeature({
      api: fakeApi({
        toolingQuery: vi.fn(async () => ({
          records: [
            rawRow({
              Status: 'Failed',
              ErrorMessage: 'Final status: Failed',
              NumberComponentErrors: 1,
            }),
          ],
          size: 1,
          done: true,
        })) as unknown as SalesforceApiClient['toolingQuery'],
        apiSoap: apiSoap as unknown as SalesforceApiClient['apiSoap'],
      }),
    });
    await feature.onActivate?.();
    await flush();
    const row = document.querySelector<HTMLTableRowElement>('tbody tr.sfdt-clickable')!;
    row.click();
    await flush();

    expect(apiSoap).toHaveBeenCalledWith(
      'Metadata',
      'checkDeployStatus',
      { id: '0Af000000000001', includeDetails: true },
      { mutating: false },
    );
    const text = document.body.textContent ?? '';
    expect(text).toContain('Foo');
    expect(text).toContain('Missing }');
    expect(text).toContain('Final status: Failed');
    expect(text).toContain('line 12');
    await feature.teardown?.();
  });

  it('SOAP rejection warns in the detail pane and still shows ErrorMessage', async () => {
    const feature = createDeployStatusFeature({
      api: fakeApi({
        toolingQuery: vi.fn(async () => ({
          records: [rawRow({ Status: 'Failed', ErrorMessage: 'Final status: Failed' })],
          size: 1,
          done: true,
        })) as unknown as SalesforceApiClient['toolingQuery'],
        apiSoap: vi.fn(async () => {
          throw new Error('INSUFFICIENT_ACCESS');
        }) as unknown as SalesforceApiClient['apiSoap'],
      }),
    });
    await feature.onActivate?.();
    await flush();
    document.querySelector<HTMLTableRowElement>('tbody tr.sfdt-clickable')!.click();
    await flush();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Final status: Failed');
    expect(text).toContain('Component errors unavailable');
    expect(text).toContain('INSUFFICIENT_ACCESS');
    expect(document.querySelector('.sfdt-console.sfdt-error')).toBeNull();
    await feature.teardown?.();
  });

  it('does not SOAP-poll a clean success', async () => {
    const apiSoap = vi.fn(async () => ({}));
    await createDeployStatusFeature({
      api: fakeApi({
        toolingQuery: vi.fn(async () => ({
          records: [rawRow()],
          size: 1,
          done: true,
        })) as unknown as SalesforceApiClient['toolingQuery'],
        apiSoap: apiSoap as unknown as SalesforceApiClient['apiSoap'],
      }),
    }).onActivate?.();
    await flush();
    document.querySelector<HTMLTableRowElement>('tbody tr.sfdt-clickable')!.click();
    await flush();
    expect(apiSoap).not.toHaveBeenCalled();
  });
});

describe('deploy-status — auto-refresh timer lifecycle', () => {
  beforeEach(() => {
    clearBody();
    setSetupUrl();
  });

  it('starts an interval while any row is in-flight, and teardown clears the exact handle', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const toolingQuery = vi.fn(async () => ({
      records: [rawRow({ Status: 'InProgress', CompletedDate: null })],
      size: 1,
      done: true,
    }));
    const feature = createDeployStatusFeature({
      api: fakeApi({
        toolingQuery: toolingQuery as unknown as SalesforceApiClient['toolingQuery'],
      }),
    });
    await feature.onActivate?.();
    await flush();
    expect(toolingQuery).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0]![1]).toBe(AUTO_REFRESH_INTERVAL_MS);
    expect(document.body.textContent).toContain('Watching in-progress deployments');
    const handle = setSpy.mock.results[0]!.value;

    const cb = setSpy.mock.calls[0]![0] as () => void;
    cb();
    await flush();
    expect(toolingQuery).toHaveBeenCalledTimes(2);
    // Still in-flight: do not start a second interval.
    expect(setSpy).toHaveBeenCalledTimes(1);

    await feature.teardown?.();
    expect(clearSpy).toHaveBeenCalledWith(handle);

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('does not start an interval when every row is terminal', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const feature = createDeployStatusFeature({
      api: fakeApi({
        toolingQuery: vi.fn(async () => ({
          records: [rawRow()],
          size: 1,
          done: true,
        })) as unknown as SalesforceApiClient['toolingQuery'],
      }),
    });
    await feature.onActivate?.();
    await flush();
    expect(setSpy).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Watching in-progress deployments');
    await feature.teardown?.();
    setSpy.mockRestore();
  });

  it('clears the interval once a later load has no in-flight rows', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    let n = 0;
    const toolingQuery = vi.fn(async () => {
      n += 1;
      return {
        records: [
          n === 1
            ? rawRow({ Status: 'InProgress', CompletedDate: null })
            : rawRow({ Status: 'Succeeded' }),
        ],
        size: 1,
        done: true,
      };
    });
    const feature = createDeployStatusFeature({
      api: fakeApi({
        toolingQuery: toolingQuery as unknown as SalesforceApiClient['toolingQuery'],
      }),
    });
    await feature.onActivate?.();
    await flush();
    const handle = setSpy.mock.results[0]!.value;
    document.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
    await flush();
    expect(clearSpy).toHaveBeenCalledWith(handle);
    expect(document.body.textContent).not.toContain('Watching in-progress deployments');
    await feature.teardown?.();
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('clears the interval when the overlay is dismissed', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const feature = createDeployStatusFeature({
      api: fakeApi({
        toolingQuery: vi.fn(async () => ({
          records: [rawRow({ Status: 'InProgress', CompletedDate: null })],
          size: 1,
          done: true,
        })) as unknown as SalesforceApiClient['toolingQuery'],
      }),
    });
    await feature.onActivate?.();
    await flush();
    const handle = setSpy.mock.results[0]!.value;
    document.querySelector<HTMLElement>('.sfdt-view-overlay')!.click();
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
    expect(clearSpy).toHaveBeenCalledWith(handle);
    await feature.teardown?.();
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });
});
