/**
 * Regression cover for issue #346: the Release Hub's "Validation completed"
 * banner rendered off `deploymentMode === 'validate'` alone, so it appeared the
 * instant the stream opened and claimed a result before anything had run.
 *
 * These tests drive the SSE handle by hand (same fake-EventSource convention as
 * CommandRunner.test.jsx) so the banner can be asserted at each point of the
 * run lifecycle: not started, mid-stream, and after the terminal `result`.
 */
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import DeployStep from './DeployStep.jsx';
import { api, stream } from '../../api.js';

vi.mock('../../api.js', () => ({
  api: {
    orgs: vi.fn(),
    project: vi.fn(),
    deployHistory: vi.fn(),
    detectTests: vi.fn(),
  },
  stream: { deploy: vi.fn() },
}));

const chat = vi.hoisted(() => ({ openChat: vi.fn(), setPageContext: vi.fn() }));
vi.mock('../../App.jsx', () => ({ ChatContext: { _currentValue: chat, _currentValue2: chat } }));

// Minimal stand-in for the SSE handle returned by stream.deploy: records the
// handlers StreamRunner assigns so tests can emit messages on demand.
function makeFakeEs() {
  const es = { handlers: {}, closed: false };
  Object.defineProperty(es, 'onmessage', { set(fn) { es.handlers.message = fn; } });
  Object.defineProperty(es, 'onerror', { set(fn) { es.handlers.error = fn; } });
  es.close = () => { es.closed = true; };
  return es;
}

const MANIFEST = { relPath: 'manifest/release/rl-1-package.xml' };
const BANNER = /Validation completed against/i;

let fakeEs;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  fakeEs = makeFakeEs();
  stream.deploy.mockReturnValue(fakeEs);
  api.orgs.mockResolvedValue({ orgs: [{ alias: 'prod', username: 'a@b.com' }, { alias: 'uat', username: 'c@d.com' }] });
  api.project.mockResolvedValue({ org: 'prod' });
  api.deployHistory.mockResolvedValue({ history: [] });
  api.detectTests.mockResolvedValue({ tests: [] });
});

const emit = (payload) => act(() => { fakeEs.handlers.message({ data: payload }); });

/** Render, wait for the org to load, switch to Validate Only, and execute. */
async function startValidation() {
  render(<DeployStep manifest={MANIFEST} onMarkDone={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole('option', { name: /prod/ })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /Validate Only/i }));
  fireEvent.click(screen.getByRole('button', { name: /Execute Validation/i }));
  await waitFor(() => expect(stream.deploy).toHaveBeenCalled());
}

describe('DeployStep validation banner', () => {
  it('does not claim completion before the run starts', async () => {
    render(<DeployStep manifest={MANIFEST} onMarkDone={vi.fn()} />);
    await waitFor(() => expect(api.orgs).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Validate Only/i }));
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });

  it('does not render the banner while the stream is still running', async () => {
    await startValidation();
    // Stream is open and producing output, but no terminal result yet.
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
    emit({ type: 'log', line: 'Validating deployment...' });
    emit({ type: 'log', line: 'Running tests...' });
    expect(screen.getByText('Running tests...')).toBeInTheDocument();
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });

  it('renders the banner with the job id once the run completes successfully', async () => {
    await startValidation();
    emit({ type: 'log', line: 'Validation Job ID: 0Af000000000001AAA' });
    emit({ type: 'result', exitCode: 0, content: { validationJobId: '0Af000000000001AAA' } });

    expect(screen.getByText(BANNER)).toBeInTheDocument();
    expect(screen.getByText('0Af000000000001AAA')).toBeInTheDocument();
    expect(screen.queryByText(/wasn’t captured/)).not.toBeInTheDocument();
  });

  it('renders the no-job-id variant only after a successful run without an id', async () => {
    await startValidation();
    emit({ type: 'result', exitCode: 0 });

    expect(screen.getByText(BANNER)).toBeInTheDocument();
    expect(screen.getByText(/wasn’t captured/)).toBeInTheDocument();
  });

  it('never renders the banner for a failed validation', async () => {
    await startValidation();
    emit({ type: 'log', line: 'Deployment failed: INVALID_FIELD' });
    emit({ type: 'result', exitCode: 1 });

    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });

  it('retracts the banner when the run is restarted from the runner', async () => {
    await startValidation();
    emit({ type: 'result', exitCode: 0, content: { validationJobId: '0Af000000000001AAA' } });
    expect(screen.getByText(BANNER)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Run again/i }));
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });
});

describe('DeployStep validation rehydrate', () => {
  const key = `sfdt_validation_${MANIFEST.relPath}`;

  it('reuses a stored job id for the org it was validated against', async () => {
    localStorage.setItem(key, JSON.stringify({
      validationJobId: '0Af000000000009AAA',
      targetOrg: 'prod',
      timestamp: Date.now(),
    }));

    render(<DeployStep manifest={MANIFEST} onMarkDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Execute Deployment/i })).toBeEnabled());

    // The stored record is adopted for the matching org: starting a deploy
    // sends it to the server so Salesforce can skip the test re-run.
    fireEvent.click(screen.getByRole('button', { name: /Execute Deployment/i }));
    await waitFor(() => expect(stream.deploy).toHaveBeenCalled());
    expect(stream.deploy.mock.calls[0][0]).toMatchObject({ validationJobId: '0Af000000000009AAA' });
  });

  it('ignores a stored job id belonging to a different org and never retargets', async () => {
    localStorage.setItem(key, JSON.stringify({
      validationJobId: '0Af000000000009AAA',
      targetOrg: 'uat',
      timestamp: Date.now(),
    }));

    render(<DeployStep manifest={MANIFEST} onMarkDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Execute Deployment/i })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: /Execute Deployment/i }));
    await waitFor(() => expect(stream.deploy).toHaveBeenCalled());
    const payload = stream.deploy.mock.calls[0][0];
    // The org the user selected wins, and the foreign job id is not offered.
    expect(payload.org).toBe('prod');
    expect(payload.validationJobId).toBeUndefined();
  });

  it('drops a stored job id older than the TTL', async () => {
    localStorage.setItem(key, JSON.stringify({
      validationJobId: '0Af000000000009AAA',
      targetOrg: 'prod',
      timestamp: Date.now() - 2 * 60 * 60 * 1000, // 2h — past the 1h TTL
    }));

    render(<DeployStep manifest={MANIFEST} onMarkDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Execute Deployment/i })).toBeEnabled());
    expect(localStorage.getItem(key)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Execute Deployment/i }));
    await waitFor(() => expect(stream.deploy).toHaveBeenCalled());
    expect(stream.deploy.mock.calls[0][0].validationJobId).toBeUndefined();
  });
});
