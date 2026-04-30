import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import Dashboard from './Dashboard.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({
  api: {
    testRuns: vi.fn(),
    preflight: vi.fn(),
    drift: vi.fn(),
  },
}));

beforeEach(() => {
  api.testRuns.mockResolvedValue({ runs: [] });
  api.preflight.mockResolvedValue({ date: null, status: null, checks: [] });
  api.drift.mockResolvedValue({ date: null, status: null, components: [] });
});

describe('Dashboard — drift activity card', () => {
  it('shows nothing when drift status is null', async () => {
    render(<Dashboard project={null} />);
    await waitFor(() => expect(api.drift).toHaveBeenCalled());
    expect(screen.queryByText(/Drift check/)).toBeNull();
  });

  it('shows drift count from components array', async () => {
    api.drift.mockResolvedValue({
      date: '2026-04-29T12:00:00.000Z',
      status: 'drift',
      components: [
        { name: 'MyClass', type: 'ApexClass', drift: 'drift' },
        { name: 'OtherClass', type: 'ApexClass', drift: 'drift' },
      ],
    });
    render(<Dashboard project={null} />);
    await waitFor(() => expect(screen.getByText(/Drift check/)).toBeInTheDocument());
    expect(screen.getByText(/2 components differ/)).toBeInTheDocument();
  });

  it('shows 0 drifted when all components are clean', async () => {
    api.drift.mockResolvedValue({
      date: '2026-04-29T12:00:00.000Z',
      status: 'clean',
      components: [{ name: 'MyClass', type: 'ApexClass', drift: 'clean' }],
    });
    render(<Dashboard project={null} />);
    await waitFor(() => expect(screen.getByText(/Drift check/)).toBeInTheDocument());
    expect(screen.getByText(/0 components differ/)).toBeInTheDocument();
  });

  it('never renders undefined in the DOM', async () => {
    render(<Dashboard project={null} />);
    await waitFor(() => expect(api.drift).toHaveBeenCalled());
    expect(document.body.textContent).not.toContain('undefined');
  });
});

describe('Dashboard — preflight activity card', () => {
  it('shows nothing when checks array is empty', async () => {
    render(<Dashboard project={null} />);
    await waitFor(() => expect(api.preflight).toHaveBeenCalled());
    expect(screen.queryByText(/Preflight —/)).toBeNull();
  });

  it('shows correct failure count in activity title', async () => {
    api.preflight.mockResolvedValue({
      date: '2026-04-29T12:00:00.000Z',
      status: 'fail',
      checks: [
        { name: 'Branch', status: 'pass', message: null },
        { name: 'Tests', status: 'fail', message: 'Below threshold' },
      ],
    });
    render(<Dashboard project={null} />);
    await waitFor(() => expect(screen.getByText(/Preflight —/)).toBeInTheDocument());
    expect(screen.getByText(/2 checks, 1 failed/)).toBeInTheDocument();
  });

  it('shows 0 failed when all checks pass', async () => {
    api.preflight.mockResolvedValue({
      date: '2026-04-29T12:00:00.000Z',
      status: 'pass',
      checks: [
        { name: 'Branch', status: 'pass', message: null },
        { name: 'Tests', status: 'pass', message: null },
      ],
    });
    render(<Dashboard project={null} />);
    await waitFor(() => expect(screen.getByText(/Preflight —/)).toBeInTheDocument());
    expect(screen.getByText(/2 checks, 0 failed/)).toBeInTheDocument();
  });
});

describe('Dashboard — test runs', () => {
  it('shows empty state when no runs exist', async () => {
    render(<Dashboard project={null} />);
    await waitFor(() => expect(api.testRuns).toHaveBeenCalled());
    expect(screen.getByText(/No test runs yet/)).toBeInTheDocument();
  });

  it('renders run rows when runs exist', async () => {
    api.testRuns.mockResolvedValue({
      runs: [
        { date: '2026-04-29T10:00:00.000Z', passed: 42, failed: 0, errors: 0, coverage: 85 },
      ],
    });
    render(<Dashboard project={null} />);
    await waitFor(() => expect(screen.getAllByText('42')[0]).toBeInTheDocument());
    expect(screen.getAllByText('42').length).toBeGreaterThanOrEqual(1);
  });
});
