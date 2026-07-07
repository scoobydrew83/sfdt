import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Dependency from './Dependency.jsx';

vi.mock('../api.js', () => ({
  api: {
    orgs: vi.fn().mockResolvedValue({ orgs: [{ alias: 'dev' }] }),
    resolveDependency: vi.fn(),
    dependencyNeighbors: vi.fn(),
  },
}));

import { api } from '../api.js';

const seedNeighbors = {
  nodes: [{ id: 'bbb', name: 'Helper', type: 'ApexClass' }],
  edges: [{ source: 'aaa', target: 'bbb' }],
  references: { hasMore: false, shown: 1 },
  referencedBy: { hasMore: false, shown: 0 },
};

async function addSeed(user, name = 'MyClass') {
  await user.type(await screen.findByPlaceholderText(/component name/i), name);
  await user.click(screen.getByRole('button', { name: /add seed/i }));
}

describe('Dependency page — seed + expand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a type chip per graph source type using its label', async () => {
    // Scoped to role=button: the seed-type <select> also renders these labels
    // as <option> text (shared TYPE_LABELS), so a plain getByText is ambiguous.
    render(<Dependency />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'LWC' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Custom Object' })).toBeInTheDocument();
  });

  it('adds a seed and shows a not-found message when unresolved', async () => {
    api.resolveDependency.mockResolvedValue({ found: false, name: 'Nope', type: 'ApexClass' });
    const user = userEvent.setup();
    render(<Dependency />);
    await addSeed(user, 'Nope');
    expect(await screen.findByText(/No .* named "Nope"/i)).toBeInTheDocument();
    expect(api.dependencyNeighbors).not.toHaveBeenCalled();
  });

  it('resolves a seed then fetches its neighbors', async () => {
    api.resolveDependency.mockResolvedValue({ found: true, id: 'aaa', name: 'MyClass', type: 'ApexClass' });
    api.dependencyNeighbors.mockResolvedValue(seedNeighbors);
    const user = userEvent.setup();
    render(<Dependency />);
    await addSeed(user);
    await waitFor(() => expect(api.dependencyNeighbors).toHaveBeenCalledWith('dev', 'aaa'));
  });

  it('shows a hub badge when a direction reports hasMore', async () => {
    api.resolveDependency.mockResolvedValue({ found: true, id: 'aaa', name: 'MyClass', type: 'ApexClass' });
    api.dependencyNeighbors.mockResolvedValue({ ...seedNeighbors, references: { hasMore: true, shown: 1 } });
    const user = userEvent.setup();
    render(<Dependency />);
    await addSeed(user);
    expect(await screen.findByText(/more/i)).toBeInTheDocument();
  });
});
