import { describe, expect, it } from 'vitest';
import {
  TrailheadProfileNotFoundError,
  TrailheadProfilePrivateError,
} from '../src/errors.js';
import { isValidHandle, normalizeEarnedAwards, normalizeProfile, toIsoDate } from '../src/normalize.js';
import { readFixtureJson } from './helpers.js';
import type { RawEarnedAwardsQueryData, RawProfileQueryData } from '../src/types.js';

const FIXED_NOW = () => new Date('2026-09-02T12:00:00.000Z');

describe('isValidHandle', () => {
  it('accepts the character set trailblazer.me slugs use', () => {
    for (const handle of ['sfdcdev', 'a', 'drew.kennedy', 'drew_kennedy', 'drew-kennedy-83']) {
      expect(isValidHandle(handle), handle).toBe(true);
    }
  });

  it('rejects anything that could smuggle a path or a query into the slug', () => {
    for (const handle of ['', ' ', 'a/b', 'a b', 'a?b=1', 'a#b', '../etc', 'a'.repeat(101)]) {
      expect(isValidHandle(handle), JSON.stringify(handle)).toBe(false);
    }
  });

  it('rejects non-strings', () => {
    expect(isValidHandle(undefined)).toBe(false);
    expect(isValidHandle(null)).toBe(false);
    expect(isValidHandle(42)).toBe(false);
  });
});

describe('toIsoDate', () => {
  it('zero-pads the non-padded dates the API actually returns', () => {
    expect(toIsoDate('2023-9-12')).toBe('2023-09-12');
    expect(toIsoDate('2019-8-5')).toBe('2019-08-05');
    expect(toIsoDate('2022-10-23')).toBe('2022-10-23');
  });

  it('returns null rather than guessing at an unparseable value', () => {
    for (const value of ['', 'yesterday', '2023-13-01', '2023-00-10', '2023-9-32', '23-9-12', null, undefined]) {
      expect(toIsoDate(value as string | null), String(value)).toBeNull();
    }
  });
});

describe('normalizeProfile', () => {
  const fixture = readFixtureJson<{ data: RawProfileQueryData }>('profile-public.json');

  it('maps a recorded public profile onto the typed surface', () => {
    const profile = normalizeProfile(fixture.data, 'example-handle', FIXED_NOW);

    expect(profile.handle).toBe('example-handle');
    expect(profile.typename).toBe('PublicProfile');
    expect(profile.stats).toEqual({
      points: 35550,
      badgeCount: 63,
      superbadgeCount: 0,
      trailCount: 4,
      rank: {
        title: 'Expeditioner',
        imageUrl:
          'https://res.cloudinary.com/trailhead/image/upload/public-trailhead/assets/images/ranks/expeditioner.png',
      },
    });
    expect(profile.fetchedAt).toBe('2026-09-02T12:00:00.000Z');
  });

  it('keeps each certification status verbatim and adds a padded ISO date', () => {
    const profile = normalizeProfile(fixture.data, 'example-handle', FIXED_NOW);

    expect(profile.certifications).toHaveLength(3);
    expect(profile.certifications[0]).toEqual({
      title: 'Salesforce Certified Platform Administrator',
      dateCompletedRaw: '2023-9-12',
      dateCompleted: '2023-09-12',
      dateExpiredRaw: null,
      dateExpired: null,
      // Verbatim: this client reports Trailhead's own label and leaves the
      // maintenance policy to callers (WEB-3).
      statusTitle: 'Maintenance Due',
      expired: false,
    });
  });

  it('refuses a private profile instead of returning a half-filled one', () => {
    const priv = readFixtureJson<{ data: RawProfileQueryData }>('profile-private.json');
    expect(priv.data.profile?.__typename).toBe('PrivateProfile');
    expect(() => normalizeProfile(priv.data, 'private-handle')).toThrow(TrailheadProfilePrivateError);
  });

  it('treats a null profile as not found', () => {
    expect(() => normalizeProfile({ profile: null }, 'nobody')).toThrow(TrailheadProfileNotFoundError);
    expect(() => normalizeProfile(null, 'nobody')).toThrow(TrailheadProfileNotFoundError);
  });

  it('degrades to nulls when the API drops fields, rather than throwing', () => {
    const profile = normalizeProfile(
      { profile: { __typename: 'PublicProfile' } },
      'sparse',
      FIXED_NOW
    );

    expect(profile.profileId).toBeNull();
    expect(profile.companyName).toBeNull();
    expect(profile.stats).toEqual({
      points: null,
      badgeCount: null,
      superbadgeCount: null,
      trailCount: null,
      rank: null,
    });
    expect(profile.certifications).toEqual([]);
  });

  it('skips null entries inside the certifications array', () => {
    const profile = normalizeProfile(
      {
        profile: {
          __typename: 'PublicProfile',
          credential: { certifications: [null, { title: 'Kept' }] },
        },
      },
      'sparse',
      FIXED_NOW
    );

    expect(profile.certifications).toHaveLength(1);
    expect(profile.certifications[0]?.title).toBe('Kept');
  });
});

describe('normalizeEarnedAwards', () => {
  const fixture = readFixtureJson<{ data: RawEarnedAwardsQueryData }>('earned-awards-page1.json');

  it('flattens the Relay connection and keeps the cursor', () => {
    const page = normalizeEarnedAwards(fixture.data, 'example-handle', FIXED_NOW);

    expect(page.handle).toBe('example-handle');
    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toEqual(expect.any(String));
    expect(page.awards.length).toBeGreaterThan(0);

    const first = page.awards[0];
    expect(first?.title).toEqual(expect.any(String));
    expect(first?.type).toEqual(expect.any(String));
    expect(first?.cursor).toEqual(expect.any(String));
  });

  it('reports an absent connection as an empty, terminal page', () => {
    const page = normalizeEarnedAwards(
      { profile: { __typename: 'PublicProfile' } },
      'sparse',
      FIXED_NOW
    );

    expect(page.awards).toEqual([]);
    expect(page.hasNextPage).toBe(false);
    expect(page.endCursor).toBeNull();
  });

  it('applies the same visibility rules as the profile query', () => {
    expect(() => normalizeEarnedAwards({ profile: { __typename: 'PrivateProfile' } }, 'p')).toThrow(
      TrailheadProfilePrivateError
    );
    expect(() => normalizeEarnedAwards({ profile: null }, 'p')).toThrow(TrailheadProfileNotFoundError);
  });
});
