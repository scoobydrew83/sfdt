import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import PreflightPage from './Preflight.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({ api: { preflight: vi.fn() } }));
vi.mock('../App.jsx', () => ({ ChatContext: { Consumer: ({ children }) => children(null), _currentValue: null } }));

beforeEach(() => {
  api.preflight.mockResolvedValue({ date: null, status: null, checks: [] });
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
});
