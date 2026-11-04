import type { DataSource } from 'typeorm';
import {
  createMigratedTestDatabase,
  dropTestDatabase,
  truncateAll,
} from '../testing/test-database';
import { FixtureListingSource, type Fixtures } from './fixture-listing-source';
import type { Listing } from './listing';
import { SourceCursor } from './source-cursor.entity';

function version(price: string): Listing {
  return { title: 'Acme', tagline: 'Fast', price, description: 'A listing' };
}

const fixtures: Fixtures = {
  acme: [version('v1'), version('v2')],
  north: [version('n1'), version('n2')],
};

describe('FixtureListingSource', () => {
  let dataSource: DataSource;
  let source: FixtureListingSource;

  /** Fetches and commits the cursor advance, as a successful poll does. */
  async function fetchAndSave(id: string): Promise<string> {
    const fetched = await source.fetchListing(id);
    await dataSource.transaction((tx) => fetched.markSaved(tx));
    return fetched.listing.price;
  }

  beforeAll(async () => {
    dataSource = await createMigratedTestDatabase('fixture_source');
    source = new FixtureListingSource(dataSource, fixtures);
  });

  afterAll(async () => {
    await dropTestDatabase(dataSource);
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
    await dataSource.query(
      `INSERT INTO competitors (id) VALUES ('acme'), ('north')`,
    );
  });

  it('returns the same version until the save is marked', async () => {
    const first = await source.fetchListing('acme');
    const second = await source.fetchListing('acme');

    expect(first.listing.price).toBe('v1');
    expect(second.listing.price).toBe('v1');
    expect(await dataSource.manager.count(SourceCursor)).toBe(0);
  });

  it('advances after the save is marked', async () => {
    expect(await fetchAndSave('acme')).toBe('v1');
    expect((await source.fetchListing('acme')).listing.price).toBe('v2');
  });

  it('does not advance if the transaction rolls back', async () => {
    const fetched = await source.fetchListing('acme');

    await expect(
      dataSource.transaction(async (tx) => {
        await fetched.markSaved(tx);
        throw new Error('save failed');
      }),
    ).rejects.toThrow('save failed');

    expect((await source.fetchListing('acme')).listing.price).toBe('v1');
  });

  it('repeats the last version once the sequence is exhausted', async () => {
    const prices = [
      await fetchAndSave('acme'),
      await fetchAndSave('acme'),
      await fetchAndSave('acme'),
      await fetchAndSave('acme'),
    ];

    expect(prices).toEqual(['v1', 'v2', 'v2', 'v2']);
  });

  it('keeps a separate position per competitor', async () => {
    await fetchAndSave('acme');

    expect((await source.fetchListing('north')).listing.price).toBe('n1');
    expect((await source.fetchListing('acme')).listing.price).toBe('v2');
  });

  it('rejects an id it does not know', async () => {
    await expect(source.fetchListing('unknown')).rejects.toThrow('unknown');
  });

  it('knows only the ids in its fixtures, not inherited object keys', async () => {
    expect(await source.isKnown('acme')).toBe(true);
    expect(await source.isKnown('unknown')).toBe(false);
    expect(await source.isKnown('constructor')).toBe(false);
  });
});
