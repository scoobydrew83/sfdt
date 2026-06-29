import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import DocsPage from './Docs.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({ api: { docs: vi.fn() } }));

const CONFIG = {
  config: { outputDir: 'docs', ai: true, diagrams: true, roleGuides: true, roles: ['developer', 'admin'] },
  aiEnabled: true,
  note: 'Run `sfdt docs generate` to build the MkDocs site.',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.docs.mockResolvedValue(CONFIG);
});

describe('DocsPage', () => {
  it('renders the configured docs settings', async () => {
    render(<DocsPage />);
    await waitFor(() => expect(screen.getByText('docs')).toBeInTheDocument());
    expect(screen.getByText(/Output Dir/i)).toBeInTheDocument();
    expect(screen.getAllByText(/sfdt docs generate/i).length).toBeGreaterThan(0);
  });

  it('shows role-guide chips when role guides are enabled', async () => {
    render(<DocsPage />);
    await waitFor(() => expect(screen.getByText('developer')).toBeInTheDocument());
    expect(screen.getByText('admin')).toBeInTheDocument();
  });

  it('shows an error state when the api rejects', async () => {
    api.docs.mockRejectedValue(new Error('cfg fail'));
    render(<DocsPage />);
    await waitFor(() => expect(screen.getByText(/Could not load docs config/i)).toBeInTheDocument());
    expect(screen.getByText('cfg fail')).toBeInTheDocument();
  });
});
