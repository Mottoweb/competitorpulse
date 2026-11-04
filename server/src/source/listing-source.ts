import type { EntityManager } from 'typeorm';
import type { Listing } from './listing';

export interface FetchedListing {
  listing: Listing;
  /** Runs in the snapshot's transaction, so its writes commit or roll back with it. */
  markSaved(tx: EntityManager): Promise<void>;
}

/** What the poller reads from. A real fetcher can replace the fixture stub here. */
export interface ListingSource {
  fetchListing(competitorId: string): Promise<FetchedListing>;
  /** Whether this source has a listing for the id at all. */
  isKnown(competitorId: string): Promise<boolean>;
}

export const LISTING_SOURCE = Symbol('LISTING_SOURCE');
