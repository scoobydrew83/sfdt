import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import SoqlConsolePage from './SoqlConsole.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({
  api: {
    orgs: vi.fn(),
    sessionOrg: vi.fn(),
    soqlSObjects: vi.fn(),
    soqlDescribe: vi.fn(),
    soqlRelationships: vi.fn(),
    soqlValidate: vi.fn(),
    soqlPlan: vi.fn(),
    soqlQuery: vi.fn(),
    soqlSosl: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  api.orgs.mockResolvedValue({ orgs: [{ alias: 'dev', username: 'a@b.com' }] });
  api.sessionOrg.mockResolvedValue({ org: 'dev' });
  api.soqlSObjects.mockResolvedValue({
    org: 'dev', term: 'acc', category: 'all',
    totalScanned: 3, totalMatched: 1, truncated: false, matches: ['Account'],
  });
  api.soqlDescribe.mockResolvedValue({
    org: 'dev', name: 'Account', label: 'Account', custom: false, queryable: true,
    keyPrefix: '001', fieldCount: 2, filter: null,
    fields: [
      { name: 'Id', label: 'Account ID', type: 'id', nillable: false, custom: false, picklistValues: [], referenceTo: [], relationshipName: null },
      { name: 'OwnerId', label: 'Owner ID', type: 'reference', nillable: false, custom: false, picklistValues: [], referenceTo: ['User'], relationshipName: 'Owner' },
    ],
    childRelationships: [{ childSObject: 'Contact', relationshipName: 'Contacts', field: 'AccountId' }],
  });
  api.soqlRelationships.mockResolvedValue({
    org: 'dev', sobject: 'Account', direction: 'both',
    parents: [{ field: 'OwnerId', relationshipName: 'Owner', referenceTo: ['User'], nillable: false }],
    children: [{ childSObject: 'Contact', relationshipName: 'Contacts', field: 'AccountId' }],
  });
  api.soqlValidate.mockResolvedValue({
    query: 'SELECT Id FROM Account', valid: true, mode: 'org', kind: 'soql', errors: [], warnings: [],
  });
  api.soqlPlan.mockResolvedValue({
    org: 'dev', apiVersion: '59.0', query: 'SELECT Id FROM Account',
    plans: [{ leadingOperationType: 'TableScan', relativeCost: 2.7, cardinality: 100, sobjectCardinality: 5000, sobjectType: 'Account', fields: [], notes: [] }],
  });
  api.soqlQuery.mockResolvedValue({
    org: 'dev', query: 'SELECT Id, Name FROM Account LIMIT 200', requestedQuery: 'SELECT Id, Name FROM Account',
    bound: { limit: 200, max: 2000, action: 'appended' },
    totalSize: 2, returned: 2, truncated: false,
    records: [{ Id: '001', Name: 'Acme' }, { Id: '002', Name: 'Globex' }],
    csv: 'Id,Name\n001,Acme\n002,Globex\n',
  });
  api.soqlSosl.mockResolvedValue({
    org: 'dev', query: 'FIND {Acme} LIMIT 200', requestedQuery: 'FIND {Acme}',
    bound: { limit: 200, max: 2000, action: 'appended' },
    returned: 1, records: [{ Id: '001' }], csv: 'Id\n001\n',
  });
});

const typeQuery = (text) =>
  fireEvent.change(screen.getByLabelText('Query editor'), { target: { value: text } });

/** Click Search once the org bootstrap has enabled it. */
const searchSchema = async () => {
  const btn = screen.getByRole('button', { name: 'Search' });
  await waitFor(() => expect(btn).toBeEnabled());
  fireEvent.click(btn);
};

describe('SoqlConsolePage', () => {
  it('searches the schema and lists matching sObjects', async () => {
    render(<SoqlConsolePage />);
    await waitFor(() => expect(api.orgs).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText('Find sObjects…'), { target: { value: 'acc' } });
    await searchSchema();

    await waitFor(() => expect(api.soqlSObjects).toHaveBeenCalledWith('dev', { term: 'acc', category: 'all' }));
    expect(await screen.findByText('Account')).toBeInTheDocument();
  });

  it('describes an sObject when picked (fields with reference targets)', async () => {
    render(<SoqlConsolePage />);
    await searchSchema();
    fireEvent.click(await screen.findByText('Account'));

    await waitFor(() => expect(api.soqlDescribe).toHaveBeenCalledWith('dev', 'Account'));
    expect(await screen.findByText('OwnerId')).toBeInTheDocument();
    expect(screen.getByText(/reference → User/)).toBeInTheDocument();
    expect(screen.getByText('2 fields')).toBeInTheDocument();
  });

  it('loads relationships lazily on the Relationships tab', async () => {
    render(<SoqlConsolePage />);
    await searchSchema();
    fireEvent.click(await screen.findByText('Account'));
    await screen.findByText('OwnerId');

    fireEvent.click(screen.getByRole('button', { name: 'Relationships' }));
    await waitFor(() => expect(api.soqlRelationships).toHaveBeenCalledWith('dev', 'Account'));
    expect(await screen.findByText(/Contacts/)).toBeInTheDocument();
    expect(screen.getByText(/Owner/)).toBeInTheDocument();
  });

  it('seeds a query from the selected sObject', async () => {
    render(<SoqlConsolePage />);
    await searchSchema();
    fireEvent.click(await screen.findByText('Account'));
    await screen.findByText('OwnerId');

    fireEvent.click(screen.getByRole('button', { name: 'Query this' }));
    expect(screen.getByLabelText('Query editor')).toHaveValue('SELECT Id FROM Account LIMIT 10');
  });

  it('shows a real schema error with a retry, never a fabricated empty list', async () => {
    api.soqlSObjects.mockRejectedValue(new Error('500 No authorization information found for dev.'));
    render(<SoqlConsolePage />);
    await waitFor(() => expect(api.orgs).toHaveBeenCalled());
    await searchSchema();

    expect(await screen.findByText(/No authorization information/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('validates the query and shows the org-mode verdict', async () => {
    render(<SoqlConsolePage />);
    await waitFor(() => expect(api.orgs).toHaveBeenCalled());
    typeQuery('SELECT Id FROM Account');
    fireEvent.click(screen.getByRole('button', { name: /Validate/ }));

    await waitFor(() => expect(api.soqlValidate).toHaveBeenCalledWith({
      query: 'SELECT Id FROM Account', org: 'dev', tooling: false,
    }));
    expect(await screen.findByText('VALID')).toBeInTheDocument();
    expect(screen.getByText(/org validation/)).toBeInTheDocument();
  });

  it('shows validation errors verbatim for an invalid query', async () => {
    api.soqlValidate.mockResolvedValue({
      query: 'q', valid: false, mode: 'org', kind: 'soql',
      errors: ["No such column 'Nope' on entity 'Account'."], warnings: [],
    });
    render(<SoqlConsolePage />);
    await waitFor(() => expect(api.orgs).toHaveBeenCalled());
    typeQuery('SELECT Nope FROM Account');
    fireEvent.click(screen.getByRole('button', { name: /Validate/ }));

    expect(await screen.findByText('INVALID')).toBeInTheDocument();
    expect(screen.getByText(/No such column 'Nope'/)).toBeInTheDocument();
  });

  it('fetches query plans', async () => {
    render(<SoqlConsolePage />);
    await waitFor(() => expect(api.orgs).toHaveBeenCalled());
    typeQuery('SELECT Id FROM Account');
    fireEvent.click(screen.getByRole('button', { name: /^Plan/ }));

    await waitFor(() => expect(api.soqlPlan).toHaveBeenCalledWith({
      query: 'SELECT Id FROM Account', org: 'dev',
    }));
    expect(await screen.findByText('TableScan')).toBeInTheDocument();
    expect(screen.getByText('2.7')).toBeInTheDocument();
  });

  it('runs a bounded query and renders the results table with bound metadata', async () => {
    render(<SoqlConsolePage />);
    await waitFor(() => expect(api.orgs).toHaveBeenCalled());
    typeQuery('SELECT Id, Name FROM Account');
    fireEvent.click(screen.getByRole('button', { name: /Run/ }));

    await waitFor(() => expect(api.soqlQuery).toHaveBeenCalledWith({
      query: 'SELECT Id, Name FROM Account', org: 'dev', tooling: false, allRows: false,
    }));
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Globex')).toBeInTheDocument();
    expect(screen.getByText(/2 row\(s\) of 2 total/)).toBeInTheDocument();
    expect(screen.getByText('LIMIT 200 applied')).toBeInTheDocument();
    // Export buttons are live once records exist.
    expect(screen.getByRole('button', { name: /JSON/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /CSV/ })).toBeEnabled();
  });

  it('passes an explicit limit through and surfaces truncation', async () => {
    api.soqlQuery.mockResolvedValue({
      org: 'dev', query: 'SELECT Id FROM Account LIMIT 50', requestedQuery: 'SELECT Id FROM Account',
      bound: { limit: 50, max: 2000, action: 'appended' },
      totalSize: 5000, returned: 50, truncated: true,
      records: [{ Id: '001' }], csv: 'Id\n001\n',
    });
    render(<SoqlConsolePage />);
    await waitFor(() => expect(api.orgs).toHaveBeenCalled());
    typeQuery('SELECT Id FROM Account');
    fireEvent.change(screen.getByLabelText('Limit'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: /Run/ }));

    await waitFor(() => expect(api.soqlQuery).toHaveBeenCalledWith({
      query: 'SELECT Id FROM Account', org: 'dev', limit: '50', tooling: false, allRows: false,
    }));
    expect(await screen.findByText(/Result truncated at the row bound/)).toBeInTheDocument();
  });

  it('routes a FIND query to the SOSL endpoint (and disables Plan)', async () => {
    render(<SoqlConsolePage />);
    await waitFor(() => expect(api.orgs).toHaveBeenCalled());
    typeQuery('FIND {Acme} IN ALL FIELDS');
    expect(screen.getByRole('button', { name: /^Plan/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Run/ }));

    await waitFor(() => expect(api.soqlSosl).toHaveBeenCalledWith({
      query: 'FIND {Acme} IN ALL FIELDS', org: 'dev',
    }));
    expect(api.soqlQuery).not.toHaveBeenCalled();
    expect(await screen.findByText(/1 row\(s\)/)).toBeInTheDocument();
  });

  it('surfaces the real execution error message', async () => {
    api.soqlQuery.mockRejectedValue(new Error('500 INVALID_TYPE: sObject type Secret__x is not supported'));
    render(<SoqlConsolePage />);
    await waitFor(() => expect(api.orgs).toHaveBeenCalled());
    typeQuery('SELECT Id FROM Secret__x');
    fireEvent.click(screen.getByRole('button', { name: /Run/ }));

    expect(await screen.findByText(/INVALID_TYPE/)).toBeInTheDocument();
  });
});
