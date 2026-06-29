import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import PreflightPage from './Preflight.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({
  api: {
    preflight: vi.fn(),
    project: vi.fn(),
    listManifests: vi.fn(),
    dependenciesPreflight: vi.fn(),
  },
}));

const chat = vi.hoisted(() => ({ setPageContext: vi.fn(), openChat: vi.fn() }));
vi.mock('../App.jsx', () => ({ ChatContext: { _currentValue: chat, _currentValue2: chat } }));

beforeEach(() => {
  vi.clearAllMocks();
  api.preflight.mockResolvedValue({ date: null, status: null, checks: [] });
  api.project.mockResolvedValue({ org: 'dev' });
  api.listManifests.mockResolvedValue({ manifests: [{ relPath: 'manifest/release/package.xml' }] });
  api.dependenciesPreflight.mockResolvedValue({ status: 'pass', missing: [], warnings: [] });
});

describe('PreflightPage', () => {
  it('shows empty state when no checks', async () => {
    render(<PreflightPage />);
    await waitFor(() => expect(api.preflight).toHaveBeenCalled());
    expect(screen.getByText(/No preflight data/i)).toBeInTheDocument();
  });

  it('renders check rows with status badges', async () => {
    api.preflight.mockResolvedValue({
      date: '2026-04-29T12:00:00.000Z',
      status: 'pass',
      checks: [
        { name: 'Branch Naming', status: 'pass', message: null },
        { name: 'Test Coverage', status: 'fail', message: 'Coverage below threshold' },
      ],
    });
    render(<PreflightPage />);
    await waitFor(() => expect(screen.getByText('Branch Naming')).toBeInTheDocument());
    expect(screen.getByText('Test Coverage')).toBeInTheDocument();
    expect(screen.getByText('Coverage below threshold')).toBeInTheDocument();
  });

  it('never renders raw objects or undefined', async () => {
    api.preflight.mockResolvedValue({
      date: '2026-04-29T12:00:00.000Z',
      status: 'pass',
      checks: [{ name: 'Branch', status: 'pass', message: null }],
    });
    render(<PreflightPage />);
    await waitFor(() => expect(api.preflight).toHaveBeenCalled());
    expect(document.body.textContent).not.toContain('[object Object]');
    expect(document.body.textContent).not.toContain('undefined');
  });

  it('pushes page context and shows the Ask AI button when a check fails', async () => {
    api.preflight.mockResolvedValue({
      date: null,
      status: 'fail',
      checks: [{ name: 'Test Coverage', status: 'fail', message: 'low' }],
    });
    render(<PreflightPage />);
    await waitFor(() => expect(chat.setPageContext).toHaveBeenCalled());
    expect(chat.setPageContext.mock.calls[0][0].page).toBe('Preflight');
    expect(screen.getByText(/Ask AI about failures/i)).toBeInTheDocument();
  });

  it('reports satisfied dependencies when the check passes', async () => {
    api.preflight.mockResolvedValue({ status: 'pass', checks: [{ name: 'X', status: 'pass' }] });
    render(<PreflightPage />);
    await waitFor(() => expect(screen.getByText(/All dependencies satisfied/i)).toBeInTheDocument());
    expect(api.dependenciesPreflight).toHaveBeenCalledWith('manifest/release/package.xml', 'dev');
  });

  it('warns when standard-type dependencies are detected', async () => {
    api.preflight.mockResolvedValue({ status: 'pass', checks: [{ name: 'X', status: 'pass' }] });
    api.dependenciesPreflight.mockResolvedValue({ status: 'warn', missing: [], warnings: [{}, {}] });
    render(<PreflightPage />);
    await waitFor(() => expect(screen.getByText(/Standard type dependencies detected \(2 warnings\)/i)).toBeInTheDocument());
  });

  it('lists missing dependencies and truncates the overflow', async () => {
    api.preflight.mockResolvedValue({ status: 'pass', checks: [{ name: 'X', status: 'pass' }] });
    api.dependenciesPreflight.mockResolvedValue({
      status: 'fail',
      missing: Array.from({ length: 7 }, (_, i) => ({
        name: `Comp${i}`,
        type: 'ApexClass',
        referencedBy: i === 0 ? ['Caller'] : [],
      })),
      warnings: [],
    });
    render(<PreflightPage />);
    await waitFor(() => expect(screen.getByText(/Comp0 \(ApexClass\) — referenced by Caller/i)).toBeInTheDocument());
    expect(screen.getByText(/and 2 more/i)).toBeInTheDocument();
  });

  it('surfaces a dependency error when no org is configured', async () => {
    api.preflight.mockResolvedValue({ status: 'pass', checks: [{ name: 'X', status: 'pass' }] });
    api.project.mockResolvedValue({ org: null });
    render(<PreflightPage />);
    await waitFor(() => expect(screen.getByText(/No default org configured/i)).toBeInTheDocument());
  });

  it('surfaces a dependency error when no manifests exist', async () => {
    api.preflight.mockResolvedValue({ status: 'pass', checks: [{ name: 'X', status: 'pass' }] });
    api.listManifests.mockResolvedValue({ manifests: [] });
    render(<PreflightPage />);
    await waitFor(() => expect(screen.getByText(/No manifests found/i)).toBeInTheDocument());
  });

  it('surfaces a thrown dependency error message', async () => {
    api.preflight.mockResolvedValue({ status: 'pass', checks: [{ name: 'X', status: 'pass' }] });
    api.dependenciesPreflight.mockRejectedValue(new Error('boom'));
    render(<PreflightPage />);
    await waitFor(() => expect(screen.getByText(/Dependency check failed: boom/i)).toBeInTheDocument());
  });
});
