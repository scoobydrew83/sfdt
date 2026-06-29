import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import DriftPage from './Drift.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({ api: { drift: vi.fn() } }));

const chat = vi.hoisted(() => ({ setPageContext: vi.fn(), openChat: vi.fn() }));
vi.mock('../App.jsx', () => ({ ChatContext: { _currentValue: chat, _currentValue2: chat } }));

beforeEach(() => {
  vi.clearAllMocks();
  api.drift.mockResolvedValue({ date: null, status: null, components: [] });
});

describe('DriftPage', () => {
  it('shows empty state when no components', async () => {
    render(<DriftPage />);
    await waitFor(() => expect(api.drift).toHaveBeenCalled());
    expect(screen.getByText(/No drift data/i)).toBeInTheDocument();
  });

  it('renders drifted components in the table', async () => {
    api.drift.mockResolvedValue({
      date: '2026-04-29T12:00:00.000Z',
      status: 'drift',
      components: [
        { name: 'MyClass', type: 'ApexClass', drift: 'drift' },
        { name: 'CleanClass', type: 'ApexClass', drift: 'clean' },
      ],
    });
    render(<DriftPage />);
    await waitFor(() => expect(screen.getByText('MyClass')).toBeInTheDocument());
    expect(screen.getByText('CleanClass')).toBeInTheDocument();
  });

  it('never renders raw objects as text', async () => {
    api.drift.mockResolvedValue({
      date: '2026-04-29T12:00:00.000Z',
      status: 'drift',
      components: [{ name: 'MyClass', type: 'ApexClass', drift: 'drift' }],
    });
    render(<DriftPage />);
    await waitFor(() => expect(api.drift).toHaveBeenCalled());
    expect(document.body.textContent).not.toContain('[object Object]');
    expect(document.body.textContent).not.toContain('undefined');
  });

  it('pushes drift page context and shows the Ask AI button when drift exists', async () => {
    api.drift.mockResolvedValue({
      date: null,
      org: 'prod',
      components: [{ name: 'MyClass', type: 'ApexClass', drift: 'drift' }],
    });
    render(<DriftPage />);
    await waitFor(() => expect(chat.setPageContext).toHaveBeenCalled());
    const ctx = chat.setPageContext.mock.calls[0][0];
    expect(ctx.page).toBe('Drift');
    expect(ctx.data).toMatchObject({ org: 'prod', driftedCount: 1, components: ['MyClass'] });
    expect(screen.getByText(/Ask AI about this drift/i)).toBeInTheDocument();
  });

  it('filters to a tab and shows the no-matches state when empty', async () => {
    api.drift.mockResolvedValue({
      date: null,
      components: [{ name: 'MyClass', type: 'ApexClass', drift: 'drift' }],
    });
    render(<DriftPage />);
    await waitFor(() => expect(screen.getByText('MyClass')).toBeInTheDocument());
    // Only drifted components exist → switching to the "Clean" tab yields no rows.
    fireEvent.click(screen.getByRole('tab', { name: /Clean/i }));
    expect(screen.getByText(/No matches/i)).toBeInTheDocument();
    expect(screen.queryByText('MyClass')).not.toBeInTheDocument();
  });
});
