import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import ScratchPage from './Scratch.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({ api: { scratch: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  api.scratch.mockResolvedValue({ pool: { size: 0, members: [] }, orgs: [] });
});

describe('ScratchPage', () => {
  it('shows empty states when pool and orgs are empty', async () => {
    render(<ScratchPage />);
    await waitFor(() => expect(api.scratch).toHaveBeenCalled());
    expect(screen.getByText(/Pool is empty/i)).toBeInTheDocument();
    expect(screen.getByText(/No scratch orgs/i)).toBeInTheDocument();
  });

  it('renders pool members and active scratch orgs', async () => {
    api.scratch.mockResolvedValue({
      pool: { size: 2, members: [{ alias: 'pool-1', orgId: '00D1', createdAt: '2026-06-20T00:00:00.000Z' }] },
      orgs: [{ alias: 'sc1', username: 'a@b.com', expirationDate: '2026-07-01', status: 'Active' }],
    });
    render(<ScratchPage />);
    await waitFor(() => expect(screen.getByText('pool-1')).toBeInTheDocument());
    expect(screen.getByText('sc1')).toBeInTheDocument();
    expect(screen.getByText('a@b.com')).toBeInTheDocument();
  });

  it('shows an error state when the api rejects', async () => {
    api.scratch.mockRejectedValue(new Error('boom'));
    render(<ScratchPage />);
    await waitFor(() => expect(screen.getByText(/Could not load scratch data/i)).toBeInTheDocument());
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('never renders raw objects', async () => {
    api.scratch.mockResolvedValue({
      pool: { size: 1, members: [{ alias: 'pool-1', orgId: '00D1' }] },
      orgs: [{ alias: 'sc1', username: 'a@b.com' }],
    });
    render(<ScratchPage />);
    await waitFor(() => expect(api.scratch).toHaveBeenCalled());
    expect(document.body.textContent).not.toContain('[object Object]');
  });
});
