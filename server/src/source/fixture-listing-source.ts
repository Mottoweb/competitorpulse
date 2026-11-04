import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { listingSchema } from './listing';
import type { FetchedListing, ListingSource } from './listing-source';
import { SourceCursor } from './source-cursor.entity';

const fixturesSchema = z.record(z.string(), z.array(listingSchema).min(1));

export type Fixtures = z.infer<typeof fixturesSchema>;

export function parseFixtures(raw: unknown): Fixtures {
  return fixturesSchema.parse(raw);
}

export function loadFixtures(): Fixtures {
  // This file runs from server/src/source, or from server/dist/src/source once built.
  const path = [
    join(__dirname, '../../../files/fixtures/listings.json'),
    join(__dirname, '../../../../files/fixtures/listings.json'),
  ].find((candidate) => existsSync(candidate));
  if (path === undefined) {
    throw new Error('Listing fixtures not found');
  }
  return parseFixtures(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * The stub from the brief: each poll gets a competitor's next version, and the
 * last version repeats. Reading doesn't advance the position. The advance
 * commits with the snapshot, so a failed save can't skip a version and a
 * restart can't cause a false change.
 */
export class FixtureListingSource implements ListingSource {
  constructor(
    private readonly dataSource: DataSource,
    private readonly fixtures: Fixtures,
  ) {}

  isKnown(competitorId: string): Promise<boolean> {
    // hasOwn, because ids like "constructor" exist on every plain object.
    return Promise.resolve(Object.hasOwn(this.fixtures, competitorId));
  }

  async fetchListing(competitorId: string): Promise<FetchedListing> {
    const versions = this.fixtures[competitorId];
    if (versions === undefined) {
      throw new Error(`Unknown competitor: ${competitorId}`);
    }

    const cursor = await this.dataSource.manager.findOne(SourceCursor, {
      where: { competitorId },
    });
    const position = cursor?.position ?? 0;
    const listing = versions[Math.min(position, versions.length - 1)];
    if (listing === undefined) {
      throw new Error(`No listing versions for: ${competitorId}`);
    }

    return {
      listing,
      markSaved: async (tx) => {
        await tx.upsert(SourceCursor, { competitorId, position: position + 1 }, [
          'competitorId',
        ]);
      },
    };
  }
}
