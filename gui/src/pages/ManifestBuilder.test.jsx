import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import ManifestBuilderPage from './ManifestBuilder.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({
  api: {
    orgs: vi.fn(),
    sessionOrg: vi.fn(),
    discoverOrgTypes: vi.fn(),
    discoverOrgMembers: vi.fn(),
    discoverComponents: vi.fn(),
    renderManifest: vi.fn(),
    saveManifest: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.orgs.mockResolvedValue({ orgs: [{ alias: 'dev', username: 'a@b.com' }] });
  api.sessionOrg.mockResolvedValue({ org: 'dev' });
  api.discoverOrgTypes.mockResolvedValue({ org: 'dev', types: ['ApexClass', 'Flow'], cached: false });
  api.discoverOrgMembers.mockResolvedValue({ org: 'dev', type: 'ApexClass', members: ['Alpha', 'Beta'], cached: false });
  api.discoverComponents.mockResolvedValue({ members: ['LocalOne'] });
  api.renderManifest.mockResolvedValue({ mode: 'additive', xml: '<?xml version="1.0"?><Package>RENDERED</Package>' });
  api.saveManifest.mockResolvedValue({ ok: true, files: [{ filename: 'rl-1.0.0-package.xml', path: 'manifest/release/rl-1.0.0-package.xml' }] });
});

describe('ManifestBuilderPage', () => {
  it('loads org types on mount for the org source', async () => {
    render(<ManifestBuilderPage />);
    await waitFor(() => expect(api.discoverOrgTypes).toHaveBeenCalledWith('dev', { refresh: false }));
    expect(await screen.findByText('ApexClass')).toBeInTheDocument();
    expect(screen.getByText('Flow')).toBeInTheDocument();
  });

  it('shows members and renders a live server-side preview when one is ticked', async () => {
    render(<ManifestBuilderPage />);
    fireEvent.click(await screen.findByText('ApexClass'));
    await waitFor(() => expect(api.discoverOrgMembers).toHaveBeenCalledWith('dev', 'ApexClass', { refresh: false }));

    fireEvent.click((await screen.findByText('Alpha')).closest('label').querySelector('input'));

    // Preview is debounced, then rendered by the server (single-writer rule)
    await waitFor(() => expect(api.renderManifest).toHaveBeenCalledWith({
      items: [{ type: 'ApexClass', member: 'Alpha' }],
      mode: 'additive',
    }), { timeout: 2000 });
    expect(await screen.findByText(/RENDERED/)).toBeInTheDocument();
  });

  it('sends the wildcard item when the whole type is ticked', async () => {
    render(<ManifestBuilderPage />);
    fireEvent.click(await screen.findByText('ApexClass'));
    await screen.findByText('Alpha');

    fireEvent.click(screen.getByText(/Entire type/).closest('label').querySelector('input'));

    await waitFor(() => expect(api.renderManifest).toHaveBeenCalledWith({
      items: [{ type: 'ApexClass', member: '*' }],
      mode: 'additive',
    }), { timeout: 2000 });
  });

  it('shows the destructive warning with the paired-file explanation', async () => {
    render(<ManifestBuilderPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Destructive/ }));
    expect(screen.getByText(/components will be DELETED/i)).toBeInTheDocument();
    expect(screen.getByText(/SFDT_DESTRUCTIVE_TIMING/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Read the docs/i })).toBeInTheDocument();
  });

  it('surfaces a visible error state when org discovery fails', async () => {
    api.discoverOrgTypes.mockRejectedValue(new Error('502 Could not list metadata'));
    render(<ManifestBuilderPage />);
    expect(await screen.findByText(/Could not list metadata/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });

  it('uses the local discover route when the source is Local', async () => {
    render(<ManifestBuilderPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Local' }));
    fireEvent.click(await screen.findByText('ApexClass'));
    await waitFor(() => expect(api.discoverComponents).toHaveBeenCalledWith('ApexClass'));
    expect(await screen.findByText('LocalOne')).toBeInTheDocument();
  });

  it('persists selections per org in localStorage', async () => {
    render(<ManifestBuilderPage />);
    fireEvent.click(await screen.findByText('ApexClass'));
    fireEvent.click((await screen.findByText('Alpha')).closest('label').querySelector('input'));

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('sfdt-manifest-builder:dev'));
      expect(stored.members.ApexClass).toEqual(['Alpha']);
    });
  });

  it('saves through POST /api/manifest/save with the release name', async () => {
    render(<ManifestBuilderPage />);
    fireEvent.click(await screen.findByText('ApexClass'));
    fireEvent.click((await screen.findByText('Alpha')).closest('label').querySelector('input'));
    await waitFor(() => expect(api.renderManifest).toHaveBeenCalled(), { timeout: 2000 });

    fireEvent.change(screen.getByPlaceholderText(/Release name/), { target: { value: '1.0.0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.saveManifest).toHaveBeenCalledWith({
      name: '1.0.0',
      mode: 'additive',
      items: [{ type: 'ApexClass', member: 'Alpha' }],
    }));
    expect(await screen.findByText(/Saved manifest\/release\/rl-1.0.0-package.xml/)).toBeInTheDocument();
  });
});
