import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import DriftPage from './Drift.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({ api: { drift: vi.fn() } }));
vi.mock('../App.jsx', () => ({ ChatContext: { Consumer: ({ children }) => children(null), _currentValue: null } }));

beforeEach(() => {
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
});
