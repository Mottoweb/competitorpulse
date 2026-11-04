import { Injectable } from '@nestjs/common';
import { DataSource, In, type EntityManager } from 'typeorm';
import { Snapshot } from '../poller/snapshot.entity';
import type { Listing } from '../source/listing';

export interface ClaimPendingSummariesInput {
  limit: number;
  retryAfterSeconds: number;
  maxAttempts: number;
}

export interface ClaimedSummary {
  snapshotId: string;
  competitorId: string;
  /** 1 for the first try. Selects the provider and fences late failure reports. */
  attempt: number;
  current: Listing;
  previous: Listing;
}

export interface CompleteSummaryInput {
  snapshotId: string;
  summary: string;
  provider: string;
  model: string;
}

export interface ScheduleSummaryRetryInput {
  snapshotId: string;
  attempt: number;
  error: string;
  retryAfterSeconds: number;
}

export interface FailSummaryInput {
  snapshotId: string;
  attempt: number;
  error: string;
}

interface ClaimedRow {
  id: string;
  competitor_id: string;
  summary_attempts: number;
  title: string;
  tagline: string;
  price: string;
  description: string;
  previous_title: string;
  previous_tagline: string;
  previous_price: string;
  previous_description: string;
}

// A changed snapshot always has a previous one: snapshots are only ever removed
// with their competitor, and the row locks held here make that delete wait.
const READ_CLAIMED_SQL = `
  SELECT cur.id, cur.competitor_id, cur.summary_attempts,
         cur.title, cur.tagline, cur.price, cur.description,
         prev.title AS previous_title, prev.tagline AS previous_tagline,
         prev.price AS previous_price, prev.description AS previous_description
  FROM snapshots cur
  JOIN LATERAL (
    SELECT p.title, p.tagline, p.price, p.description
    FROM snapshots p
    WHERE p.competitor_id = cur.competitor_id AND p.id < cur.id
    ORDER BY p.id DESC
    LIMIT 1
  ) prev ON true
  WHERE cur.id = ANY($1::bigint[])
  ORDER BY cur.id`;

function toClaimedSummary(row: ClaimedRow): ClaimedSummary {
  return {
    snapshotId: row.id,
    competitorId: row.competitor_id,
    attempt: row.summary_attempts,
    current: {
      title: row.title,
      tagline: row.tagline,
      price: row.price,
      description: row.description,
    },
    previous: {
      title: row.previous_title,
      tagline: row.previous_tagline,
      price: row.previous_price,
      description: row.previous_description,
    },
  };
}

@Injectable()
export class SummaryQueries {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Claims due summaries in one short transaction, which commits before any LLM
   * call. The attempt is counted and the retry time set here, so a crash brings
   * the row back and still uses up an attempt.
   *
   * A row already at the cap means its last attempt never reported back. It is
   * marked failed here, because no worker is left to do it.
   */
  claimPendingSummaries(
    input: ClaimPendingSummariesInput,
  ): Promise<ClaimedSummary[]> {
    return this.dataSource.transaction(async (tx) => {
      const due = await tx
        .createQueryBuilder(Snapshot, 'snapshot')
        .select(['snapshot.id', 'snapshot.summaryAttempts'])
        // A literal, not a parameter, so the row matches the partial index predicate.
        .where(`snapshot.summaryStatus = 'pending'`)
        .andWhere('snapshot.summaryNextAttemptAt <= now()')
        .orderBy('snapshot.summaryNextAttemptAt', 'ASC')
        .limit(input.limit)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();

      const idsAt = (atCap: boolean): string[] =>
        due
          .filter((row) => row.summaryAttempts >= input.maxAttempts === atCap)
          .map((row) => row.id);
      const exhausted = idsAt(true);
      const claimable = idsAt(false);

      if (exhausted.length > 0) {
        await tx.update(
          Snapshot,
          { id: In(exhausted) },
          {
            summaryStatus: 'failed',
            summaryNextAttemptAt: null,
            summaryError: 'Attempts exhausted: the last attempt never reported a result',
          },
        );
      }
      if (claimable.length === 0) {
        return [];
      }

      await this.setRetryTime(tx, claimable, input.retryAfterSeconds, true);
      const rows = await tx.query<ClaimedRow[]>(READ_CLAIMED_SQL, [claimable]);
      return rows.map(toClaimedSummary);
    });
  }

  /**
   * Accepts a result from any attempt while the row is pending, even a late one,
   * because that call is already paid for. Returns false if the row has moved on.
   */
  async completeSummary(input: CompleteSummaryInput): Promise<boolean> {
    const result = await this.dataSource.manager.update(
      Snapshot,
      { id: input.snapshotId, summaryStatus: 'pending' },
      {
        summary: input.summary,
        summaryStatus: 'done',
        summaryProvider: input.provider,
        summaryModel: input.model,
        summaryNextAttemptAt: null,
        summaryError: null,
      },
    );
    return result.affected === 1;
  }

  /**
   * Applies only to the latest attempt, so a late failure can't disturb an
   * attempt that has replaced it. Returns false if the attempt was superseded.
   */
  scheduleSummaryRetry(input: ScheduleSummaryRetryInput): Promise<boolean> {
    return this.dataSource.transaction(async (tx) => {
      const recorded = await tx.update(
        Snapshot,
        {
          id: input.snapshotId,
          summaryStatus: 'pending',
          summaryAttempts: input.attempt,
        },
        { summaryError: input.error },
      );
      if (recorded.affected !== 1) {
        return false;
      }
      await this.setRetryTime(
        tx,
        [input.snapshotId],
        input.retryAfterSeconds,
        false,
      );
      return true;
    });
  }

  /** Same attempt check as scheduleSummaryRetry. The listing is never touched. */
  async failSummary(input: FailSummaryInput): Promise<boolean> {
    const result = await this.dataSource.manager.update(
      Snapshot,
      {
        id: input.snapshotId,
        summaryStatus: 'pending',
        summaryAttempts: input.attempt,
      },
      {
        summaryStatus: 'failed',
        summaryError: input.error,
        summaryNextAttemptAt: null,
      },
    );
    return result.affected === 1;
  }

  private async setRetryTime(
    tx: EntityManager,
    ids: string[],
    retryAfterSeconds: number,
    countAttempt: boolean,
  ): Promise<void> {
    await tx
      .createQueryBuilder()
      .update(Snapshot)
      .set({
        summaryNextAttemptAt: () =>
          'now() + make_interval(secs => :retryAfterSeconds::double precision)',
        ...(countAttempt
          ? { summaryAttempts: () => 'summary_attempts + 1' }
          : {}),
      })
      .where({ id: In(ids) })
      .setParameters({ retryAfterSeconds })
      .execute();
  }
}
