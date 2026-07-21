import type { SalesforceApiClient } from './salesforce-api.js';

// REST vs Tooling describe endpoints. Kept here (not in soql-runner) so every
// consumer of the shared cache agrees on the mode literal.
export type ApiMode = 'rest' | 'tooling';

// --- METADATA DESCRIBE INTERFACES ---
// The additive fields below are populated straight from the Salesforce describe
// payload (the cache passes `data` through wholesale, so extra properties on the
// wire arrive on the object already). They are declared optional so nothing that
// already depends on the base shape breaks.
export interface FieldDescribe {
  name: string;
  label: string;
  type: string;
  relationshipName: string | null;
  referenceTo: string[];
  picklistValues: { value: string; label: string }[];
  nillable: boolean;
  calculated: boolean;
  // Additive (P2-1):
  length?: number;
  calculatedFormula?: string | null;
  precision?: number;
  scale?: number;
  custom?: boolean;
  // Component fields of an address/geolocation compound point back at their
  // parent via compoundFieldName — the viewmodel uses it to flatten compounds.
  compoundFieldName?: string | null;
}

export interface ChildRelationship {
  childSObject: string;
  field: string;
  relationshipName: string | null;
}

export interface SObjectDescribe {
  name: string;
  label: string;
  fields: FieldDescribe[];
  // Additive (P2-1): mapped from the describe payload's childRelationships.
  childRelationships?: ChildRelationship[];
}

export interface GlobalDescribe {
  sobjects: { name: string; label: string; keyPrefix: string | null }[];
}

type CacheEntry<T> = { status: 'loading' | 'ready' | 'error'; data?: T };

export class DescribeCache {
  private api: SalesforceApiClient;
  private globalCache = new Map<ApiMode, CacheEntry<GlobalDescribe>>();
  private sobjectCache = new Map<string, CacheEntry<SObjectDescribe>>();
  private listeners = new Set<() => void>();

  // `onUpdate` is optional and, when given, registered as a listener — this
  // keeps the historical `new DescribeCache(api, cb)` construction working while
  // the shared singleton (getDescribeCache) is built without one and callers
  // attach via subscribe().
  constructor(api: SalesforceApiClient, onUpdate?: () => void) {
    this.api = api;
    if (onUpdate) this.listeners.add(onUpdate);
  }

  // Register a change listener; returns an unsubscribe. Multiple consumers of
  // the shared cache each subscribe so an async describe re-renders all of them.
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  clear(): void {
    this.globalCache.clear();
    this.sobjectCache.clear();
  }

  getGlobal(mode: ApiMode) {
    const cached = this.globalCache.get(mode);
    if (cached) return cached;

    this.globalCache.set(mode, { status: 'loading' });
    const apiVersion = this.api.apiVersion;
    const endpoint = mode === 'tooling'
      ? `/services/data/${apiVersion}/tooling/sobjects/`
      : `/services/data/${apiVersion}/sobjects/`;

    this.api.apiGet<GlobalDescribe>(endpoint)
      .then(data => {
        const enriched = data && Array.isArray(data.sobjects) ? data : { sobjects: [] };
        this.globalCache.set(mode, { status: 'ready', data: enriched });
        this.notify();
      })
      .catch(err => {
        console.error('Failed to describe global', err);
        this.globalCache.set(mode, { status: 'error' });
        this.notify();
      });

    return { status: 'loading' as const };
  }

  getSObject(mode: ApiMode, name: string) {
    const key = `${mode}:${name.toLowerCase()}`;
    const cached = this.sobjectCache.get(key);
    if (cached) return cached;

    this.sobjectCache.set(key, { status: 'loading' });
    const apiVersion = this.api.apiVersion;
    const endpoint = mode === 'tooling'
      ? `/services/data/${apiVersion}/tooling/sobjects/${name}/describe`
      : `/services/data/${apiVersion}/sobjects/${name}/describe`;

    this.api.apiGet<SObjectDescribe>(endpoint)
      .then(data => {
        const enriched = data && Array.isArray(data.fields) ? data : { name, label: name, fields: [] };
        this.sobjectCache.set(key, { status: 'ready', data: enriched });
        this.notify();
      })
      .catch(err => {
        console.error('Failed to describe sobject', name, err);
        this.sobjectCache.set(key, { status: 'error' });
        this.notify();
      });

    return { status: 'loading' as const };
  }
}

// --- SESSION SINGLETON (keyed by org origin) ---
// One DescribeCache per org origin, reused across every caller in the session,
// so a describe fetched by one consumer (e.g. soql-runner autocomplete) is
// reused by the next. Mirrors the getSalesforceApi() singleton idiom.
const _caches = new Map<string, DescribeCache>();

export function getDescribeCache(api: SalesforceApiClient): DescribeCache {
  const key = api.orgOrigin ?? '';
  let cache = _caches.get(key);
  if (!cache) {
    cache = new DescribeCache(api);
    _caches.set(key, cache);
  }
  return cache;
}

export function _resetDescribeCachesForTests(): void {
  _caches.clear();
}
