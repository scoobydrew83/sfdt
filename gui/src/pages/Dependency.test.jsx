import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import Dependency from './Dependency.jsx';

// Mock the api module so no network/SVG work is needed for chip assertions.
vi.mock('../api.js', () => ({
  api: {
    orgs: vi.fn().mockResolvedValue([{ alias: 'dev' }]),
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
  });
});
