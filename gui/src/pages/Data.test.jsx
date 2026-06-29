import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import DataPage from './Data.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({ api: { data: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  api.data.mockResolvedValue({ sets: [] });
});

describe('DataPage', () => {
  it('shows the empty state when there are no data sets', async () => {
    render(<DataPage />);
    await waitFor(() => expect(api.data).toHaveBeenCalled());
    expect(screen.getByText(/No data sets/i)).toBeInTheDocument();
  });

  it('lists configured data sets', async () => {
    api.data.mockResolvedValue({ sets: ['accounts', 'contacts'] });
    render(<DataPage />);
    await waitFor(() => expect(screen.getByText('accounts')).toBeInTheDocument());
    expect(screen.getByText('contacts')).toBeInTheDocument();
  });

  it('shows an error state when the api rejects', async () => {
    api.data.mockRejectedValue(new Error('nope'));
    render(<DataPage />);
    await waitFor(() => expect(screen.getByText(/Could not load data sets/i)).toBeInTheDocument());
    expect(screen.getByText('nope')).toBeInTheDocument();
  });
});
