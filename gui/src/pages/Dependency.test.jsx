import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import Dependency from './Dependency.jsx';
import { api } from '../api.js';

// Mock the api module so no network/SVG work is needed for chip assertions.
vi.mock('../api.js', () => ({
  api: {
    orgs: vi.fn().mockResolvedValue({ orgs: [{ alias: 'dev' }] }),
    dependencies: vi.fn().mockResolvedValue({ nodes: [], edges: [], truncated: false }),
  },
}));

describe('Dependency page — type chips', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a chip per graph source type using its label', async () => {
    render(<Dependency />);
    await waitFor(() => expect(screen.getByText('LWC')).toBeInTheDocument());
    expect(screen.getByText('Aura Component')).toBeInTheDocument();
    expect(screen.getByText('Custom Object')).toBeInTheDocument();
    expect(screen.getByText('Custom Field')).toBeInTheDocument();
  });

  it('marks code types active and object/field chips inactive by default', async () => {
    render(<Dependency />);
    const lwc = await screen.findByText('LWC');
    const obj = await screen.findByText('Custom Object');
    expect(lwc.closest('button').className).toContain('active');
    expect(obj.closest('button').className).not.toContain('active');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the truncation banner when the API reports truncation', async () => {
    api.dependencies.mockResolvedValue({ nodes: [], edges: [], truncated: true });
    render(<Dependency />);
    const loadBtn = await screen.findByRole('button', { name: /Load Graph/i });
    await waitFor(() => expect(loadBtn).not.toBeDisabled());
    fireEvent.click(loadBtn);
    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('first 5000');
  });
});
