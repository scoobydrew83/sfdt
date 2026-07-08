import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Dependency from './Dependency.jsx';

vi.mock('../api.js', () => ({
  api: {
    orgs: vi.fn().mockResolvedValue({ orgs: [{ alias: 'dev' }] }),
    resolveDependency: vi.fn(),
    dependencyNeighbors: vi.fn(),
    dependencyGaps: vi.fn(),
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

  it('shows the gaps table when the Gaps toggle is on', async () => {
    api.dependencyGaps.mockResolvedValue({ from: { name: 'AccountSvc', type: 'ApexClass' }, gaps: [
      { ref: { toName: 'BillingHandler', toType: 'ApexClass', kind: 'apex-dynamic', evidence: "Type.forName('BillingHandler')", line: 42 }, status: 'inferred' },
    ] });
    const user = userEvent.setup();
    render(<Dependency />);
    await user.type(await screen.findByPlaceholderText(/component name/i), 'AccountSvc');
    await user.click(screen.getByRole('button', { name: /gaps/i }));
    expect(await screen.findByText('BillingHandler')).toBeInTheDocument();
    expect(screen.getByText(/apex-dynamic/i)).toBeInTheDocument();
  });

  it('overlays only "missing" inferred edges as dashed when Show inferred is on', async () => {
    api.resolveDependency.mockResolvedValue({ found: true, id: 'aaa', name: 'AccountSvc', type: 'ApexClass' });
    api.dependencyNeighbors.mockResolvedValue({ nodes: [], edges: [], references: { hasMore: false, shown: 0 }, referencedBy: { hasMore: false, shown: 0 } });
    api.dependencyGaps.mockResolvedValue({ from: { name: 'AccountSvc', type: 'ApexClass' }, gaps: [
      { ref: { toName: 'BillingHandler', toType: 'ApexClass', kind: 'apex-dynamic', evidence: "Type.forName('BillingHandler')", line: 1 }, status: 'missing' },
      { ref: { toName: 'AlreadyKnown',   toType: 'ApexClass', kind: 'apex-dynamic', evidence: "Type.forName('AlreadyKnown')",   line: 2 }, status: 'confirmed' },
    ] });
    const user = userEvent.setup();
    const { container } = render(<Dependency />);
    // seed the graph (AccountSvc becomes an expanded node)
    await user.type(await screen.findByPlaceholderText(/component name/i), 'AccountSvc');
    await user.click(screen.getByRole('button', { name: /add seed/i }));
    await screen.findByText('AccountSvc');
    // turn on the inferred overlay
    await user.click(screen.getByRole('button', { name: /show inferred/i }));
    // the missing ref becomes a synthetic node + a dashed edge; the confirmed ref does not
    expect(await screen.findByText('BillingHandler')).toBeInTheDocument();
    expect(screen.queryByText('AlreadyKnown')).toBeNull();
    await waitFor(() => expect(container.querySelector('line[stroke-dasharray]')).toBeTruthy());
    expect(api.dependencyGaps).toHaveBeenCalledWith('dev', 'AccountSvc', 'ApexClass');
  });
});
