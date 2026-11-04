import { Injectable } from '@nestjs/common';
import { DataSource, In, type EntityManager } from 'typeorm';
import { z } from 'zod';
import { Competitor } from '../competitors/competitor.entity';
import type { Listing } from '../source/listing';
import { contentHash } from './content-hash';
import { Snapshot } from './snapshot.entity';

export interface ClaimDueCompetitorsInput {
  limit: number;
  intervalSeconds: number;
  /** 0.1 spreads the next poll over the interval plus or minus 10%. */
  jitterRatio: number;
}

export interface ClaimedCompetitor {
  id: string;
  /** Tells this competitor apart from a later one re-added with the same id. */
  createdAt: Date;
}

export interface SaveSnapshotInput {
  competitorId: string;
  listing: Listing;
  fetchedAt: Date;
  /** When set, the save is dropped if the competitor was re-added since this claim. */
  claimedCreatedAt?: Date;
  /** Runs inside the save transaction, so its writes commit or roll back with the snapshot. */
  inTransaction?: (tx: EntityManager) => Promise<void>;
}

export interface SavedSnapshot {
  id: string;
  changed: boolean;
  /** True when the competitor had no earlier snapshot. */
  first: boolean;
}

const insertedIdSchema = z.object({ id: z.string() });

@Injectable()
export class SnapshotQueries {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Claims due competitors and moves their next poll forward in one short
   * transaction, which commits before any fetch starts. Time comes from the
   * database, so every instance shares one clock.
   */
  claimDueCompetitors(
    input: ClaimDueCompetitorsInput,
  ): Promise<ClaimedCompetitor[]> {
    return this.dataSource.transaction(async (tx) => {
      const due = await tx
        .createQueryBuilder(Competitor, 'competitor')
        .select(['competitor.id', 'competitor.createdAt'])
        .where('competitor.nextPollAt <= now()')
        .orderBy('competitor.nextPollAt', 'ASC')
        .limit(input.limit)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();
      const ids = due.map((competitor) => competitor.id);
      if (ids.length === 0) {
        return [];
      }

      // random() runs per row, so one batch update still jitters each competitor.
      // The base is now(), not the old next_poll_at, so an overdue competitor
      // is polled once rather than catching up on every missed interval.
      await tx
        .createQueryBuilder()
        .update(Competitor)
        .set({
          nextPollAt: () =>
            `now() + make_interval(secs => :intervalSeconds::double precision
              * (1 + :jitterRatio::double precision * (2 * random() - 1)))`,
        })
        .where({ id: In(ids) })
        .setParameters({
          intervalSeconds: input.intervalSeconds,
          jitterRatio: input.jitterRatio,
        })
        .execute();
      return due.map(({ id, createdAt }) => ({ id, createdAt }));
    });
  }

  /**
   * Compares with the previous snapshot and saves in one transaction. Returns
   * null when the competitor no longer exists, or isn't the one that was
   * claimed, so an old fetch can't enter a new history. The competitor row lock makes
   * concurrent saves take turns, and each one's previous snapshot is the save
   * that went before it.
   */
  saveSnapshot(input: SaveSnapshotInput): Promise<SavedSnapshot | null> {
    const { competitorId, listing, fetchedAt, claimedCreatedAt } = input;
    return this.dataSource.transaction(async (tx) => {
      const competitor = await tx.findOne(Competitor, {
        where: { id: competitorId },
        select: { id: true, createdAt: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        competitor === null ||
        (claimedCreatedAt !== undefined &&
          competitor.createdAt.getTime() !== claimedCreatedAt.getTime())
      ) {
        return null;
      }

      const previous = await tx.findOne(Snapshot, {
        where: { competitorId },
        select: { contentHash: true },
        order: { id: 'DESC' },
      });
      const hash = contentHash(listing);
      const changed = previous !== null && previous.contentHash !== hash;

      const result = await tx.insert(Snapshot, {
        competitorId,
        fetchedAt,
        title: listing.title,
        tagline: listing.tagline,
        price: listing.price,
        description: listing.description,
        contentHash: hash,
        changed,
        summaryStatus: changed ? 'pending' : 'none',
        summaryNextAttemptAt: changed ? () => 'now()' : null,
      });
      await input.inTransaction?.(tx);

      const { id } = insertedIdSchema.parse(result.identifiers[0]);
      return { id, changed, first: previous === null };
    });
  }

  /** Newest first. Ordered by id, which follows save order for one competitor. */
  listTimeline(competitorId: string, limit?: number): Promise<Snapshot[]> {
    return this.dataSource.manager.find(Snapshot, {
      where: { competitorId },
      order: { id: 'DESC' },
      take: limit,
    });
  }
}
