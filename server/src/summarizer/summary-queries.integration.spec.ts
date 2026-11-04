import type { DataSource } from 'typeorm';
import { Snapshot } from '../poller/snapshot.entity';
import type { Listing } from '../source/listing';
import {
  createMigratedTestDatabase,
  dropTestDatabase,
  truncateAll,
} from '../testing/test-database';
import { SummaryQueries } from './summary-queries';

const CLAIM = { limit: 10, retryAfterSeconds: 60, maxAttempts: 3 };

const v1: Listing = {
  title: 'Acme CRM',
  tagline: 'Simple CRM',
  price: '$29/mo',
  description: 'Track leads.',
};
const v2: Listing = { ...v1, price: '$39/mo' };
const v3: Listing = { ...v1, price: '$49/mo' };

describe('SummaryQueries', () => {
  let dataSource: DataSource;
  let queries: SummaryQueries;

  /** Inserts directly, so these tests don't depend on SnapshotQueries. */
  async function insertSnapshot(
    competitorId: string,
    listing: Listing,
    pending: boolean,
  ): Promise<string> {
    const rows = await dataSource.query<{ id: string }[]>(
      `INSERT INTO snapshots (competitor_id, fetched_at, title, tagline, price,
         description, content_hash, changed, summary_status, summary_next_attempt_at)
       VALUES ($1, now(), $2, $3, $4, $5, 'hash', $6, $7,
         CASE WHEN $6 THEN now() END)
       RETURNING id`,
      [
        competitorId,
        listing.title,
        listing.tagline,
        listing.price,
        listing.description,
        pending,
        pending ? 'pending' : 'none',
      ],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error('Test setup failed to insert the snapshot');
    }
    return id;
  }

  /** Adds a competitor whose newest snapshot needs a summary, and returns that snapshot's id. */
  async function addPendingSummary(competitorId: string): Promise<string> {
    await dataSource.query(`INSERT INTO competitors (id) VALUES ($1)`, [
      competitorId,
    ]);
    await insertSnapshot(competitorId, v1, false);
    return insertSnapshot(competitorId, v2, true);
  }

  async function makeDue(snapshotId: string): Promise<void> {
    await dataSource.query(
      `UPDATE snapshots SET summary_next_attempt_at = now() - interval '1 second'
       WHERE id = $1`,
      [snapshotId],
    );
  }

  async function load(snapshotId: string): Promise<Snapshot> {
    return dataSource.manager.findOneByOrFail(Snapshot, { id: snapshotId });
  }

  async function secondsUntilNextAttempt(snapshotId: string): Promise<number> {
    const rows = await dataSource.query<{ seconds: number }[]>(
      `SELECT EXTRACT(EPOCH FROM summary_next_attempt_at - now())::float AS seconds
       FROM snapshots WHERE id = $1`,
      [snapshotId],
    );
    return rows[0]?.seconds ?? Number.NaN;
  }

  beforeAll(async () => {
    dataSource = await createMigratedTestDatabase('summary_queries');
    queries = new SummaryQueries(dataSource);
  });

  afterAll(async () => {
    await dropTestDatabase(dataSource);
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
  });

  describe('claimPendingSummaries', () => {
    it('returns the attempt number with the current and previous listings', async () => {
      const id = await addPendingSummary('a');

      await expect(queries.claimPendingSummaries(CLAIM)).resolves.toEqual([
        {
          snapshotId: id,
          competitorId: 'a',
          attempt: 1,
          current: v2,
          previous: v1,
        },
      ]);
    });

    it('uses the immediately preceding snapshot as previous', async () => {
      const first = await addPendingSummary('a');
      const third = await insertSnapshot('a', v3, true);
      await queries.completeSummary({
        snapshotId: first,
        summary: 's',
        provider: 'p',
        model: 'm',
      });

      const [claimed] = await queries.claimPendingSummaries(CLAIM);

      expect(claimed?.snapshotId).toBe(third);
      expect(claimed?.current).toEqual(v3);
      expect(claimed?.previous).toEqual(v2);
    });

    it('counts the attempt and sets the retry time when it claims', async () => {
      const id = await addPendingSummary('a');

      await queries.claimPendingSummaries(CLAIM);

      const row = await load(id);
      expect(row.summaryStatus).toBe('pending');
      expect(row.summaryAttempts).toBe(1);
      const seconds = await secondsUntilNextAttempt(id);
      expect(seconds).toBeGreaterThan(55);
      expect(seconds).toBeLessThanOrEqual(60);
    });

    it('ignores rows that are not pending or not yet due', async () => {
      await dataSource.query(`INSERT INTO competitors (id) VALUES ('none')`);
      await insertSnapshot('none', v1, false);
      const done = await addPendingSummary('done');
      await queries.completeSummary({
        snapshotId: done,
        summary: 's',
        provider: 'p',
        model: 'm',
      });
      const notDue = await addPendingSummary('not-due');
      await dataSource.query(
        `UPDATE snapshots SET summary_next_attempt_at = now() + interval '1 hour'
         WHERE id = $1`,
        [notDue],
      );
      const failed = await addPendingSummary('failed');
      await queries.failSummary({ snapshotId: failed, attempt: 0, error: 'x' });

      await expect(queries.claimPendingSummaries(CLAIM)).resolves.toEqual([]);
    });

    it('claims the longest waiting first, up to the limit', async () => {
      const later = await addPendingSummary('later');
      const earlier = await addPendingSummary('earlier');
      await dataSource.query(
        `UPDATE snapshots SET summary_next_attempt_at = now() - interval '1 hour'
         WHERE id = $1`,
        [earlier],
      );
      await makeDue(later);

      const claimed = await queries.claimPendingSummaries({
        ...CLAIM,
        limit: 1,
      });

      expect(claimed.map((row) => row.snapshotId)).toEqual([earlier]);
    });

    it('brings a crashed attempt back only after the retry time', async () => {
      const id = await addPendingSummary('a');
      await queries.claimPendingSummaries(CLAIM);

      await expect(queries.claimPendingSummaries(CLAIM)).resolves.toEqual([]);

      await makeDue(id);
      const [retried] = await queries.claimPendingSummaries(CLAIM);
      expect(retried?.snapshotId).toBe(id);
      expect(retried?.attempt).toBe(2);
    });

    it('marks a row failed instead of claiming past the attempt cap', async () => {
      const id = await addPendingSummary('a');
      await dataSource.query(
        `UPDATE snapshots SET summary_attempts = 3 WHERE id = $1`,
        [id],
      );

      await expect(queries.claimPendingSummaries(CLAIM)).resolves.toEqual([]);

      const row = await load(id);
      expect(row).toMatchObject({
        summaryStatus: 'failed',
        summaryAttempts: 3,
        summaryNextAttemptAt: null,
        summary: null,
        price: v2.price,
      });
      expect(row.summaryError).toMatch(/attempts/i);
    });

    it('still claims other rows in a batch that reaches the cap', async () => {
      const capped = await addPendingSummary('capped');
      const fresh = await addPendingSummary('fresh');
      await dataSource.query(
        `UPDATE snapshots SET summary_attempts = 3 WHERE id = $1`,
        [capped],
      );

      const claimed = await queries.claimPendingSummaries(CLAIM);

      expect(claimed.map((row) => row.snapshotId)).toEqual([fresh]);
    });

    it('skips a row locked by another transaction instead of waiting for it', async () => {
      const locked = await addPendingSummary('locked');
      const free = await addPendingSummary('free');
      const holder = dataSource.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      try {
        await holder.query(`SELECT id FROM snapshots WHERE id = $1 FOR UPDATE`, [
          locked,
        ]);

        const claimed = await queries.claimPendingSummaries(CLAIM);

        expect(claimed.map((row) => row.snapshotId)).toEqual([free]);
      } finally {
        await holder.rollbackTransaction();
        await holder.release();
      }
    });

    it('never gives the same summary to two concurrent claims', async () => {
      const ids = await Promise.all(
        Array.from({ length: 30 }, (_, index) =>
          addPendingSummary(`c${index}`),
        ),
      );

      const claims = await Promise.all(
        Array.from({ length: 5 }, () =>
          queries.claimPendingSummaries({ ...CLAIM, limit: 10 }),
        ),
      );

      const claimed = claims.flat().map((row) => row.snapshotId);
      expect(new Set(claimed).size).toBe(claimed.length);
      expect([...claimed].sort()).toEqual([...ids].sort());
    });
  });

  describe('completeSummary', () => {
    const result = { summary: 'Price rose.', provider: 'deepseek', model: 'm1' };

    it('stores the summary and clears the retry state, leaving the listing alone', async () => {
      const id = await addPendingSummary('a');
      await queries.claimPendingSummaries(CLAIM);
      await dataSource.query(
        `UPDATE snapshots SET summary_error = 'earlier failure' WHERE id = $1`,
        [id],
      );

      await expect(
        queries.completeSummary({ snapshotId: id, ...result }),
      ).resolves.toBe(true);

      expect(await load(id)).toMatchObject({
        summary: 'Price rose.',
        summaryStatus: 'done',
        summaryProvider: 'deepseek',
        summaryModel: 'm1',
        summaryNextAttemptAt: null,
        summaryError: null,
        summaryAttempts: 1,
        changed: true,
        ...v2,
      });
    });

    it('keeps a late result that arrives while the row is still pending', async () => {
      const id = await addPendingSummary('a');
      await queries.claimPendingSummaries(CLAIM);
      await makeDue(id);
      await queries.claimPendingSummaries(CLAIM);

      await expect(
        queries.completeSummary({ snapshotId: id, ...result }),
      ).resolves.toBe(true);
    });

    it('does not overwrite a summary that is already done', async () => {
      const id = await addPendingSummary('a');
      await queries.completeSummary({ snapshotId: id, ...result });

      await expect(
        queries.completeSummary({
          snapshotId: id,
          summary: 'Second result.',
          provider: 'openai',
          model: 'm2',
        }),
      ).resolves.toBe(false);

      expect((await load(id)).summary).toBe('Price rose.');
    });

    it('does not revive a summary that has failed', async () => {
      const id = await addPendingSummary('a');
      await queries.failSummary({ snapshotId: id, attempt: 0, error: 'x' });

      await expect(
        queries.completeSummary({ snapshotId: id, ...result }),
      ).resolves.toBe(false);

      expect((await load(id)).summaryStatus).toBe('failed');
    });
  });

  describe('scheduleSummaryRetry', () => {
    it('records the error and moves the retry time, staying pending', async () => {
      const id = await addPendingSummary('a');
      const [claimed] = await queries.claimPendingSummaries(CLAIM);

      await expect(
        queries.scheduleSummaryRetry({
          snapshotId: id,
          attempt: claimed?.attempt ?? 0,
          error: '429 from deepseek',
          retryAfterSeconds: 10,
        }),
      ).resolves.toBe(true);

      expect(await load(id)).toMatchObject({
        summaryStatus: 'pending',
        summaryError: '429 from deepseek',
        summaryAttempts: 1,
      });
      expect(await secondsUntilNextAttempt(id)).toBeLessThanOrEqual(10);
    });

    it('ignores a failure report from an attempt that has been superseded', async () => {
      const id = await addPendingSummary('a');
      await queries.claimPendingSummaries(CLAIM);
      await makeDue(id);
      await queries.claimPendingSummaries(CLAIM);

      await expect(
        queries.scheduleSummaryRetry({
          snapshotId: id,
          attempt: 1,
          error: 'late',
          retryAfterSeconds: 0,
        }),
      ).resolves.toBe(false);

      const row = await load(id);
      expect(row.summaryError).toBeNull();
      expect(await secondsUntilNextAttempt(id)).toBeGreaterThan(55);
    });
  });

  describe('failSummary', () => {
    it('marks the row failed with the error, keeping the snapshot', async () => {
      const id = await addPendingSummary('a');
      const [claimed] = await queries.claimPendingSummaries(CLAIM);

      await expect(
        queries.failSummary({
          snapshotId: id,
          attempt: claimed?.attempt ?? 0,
          error: 'all providers failed',
        }),
      ).resolves.toBe(true);

      expect(await load(id)).toMatchObject({
        summaryStatus: 'failed',
        summaryError: 'all providers failed',
        summaryNextAttemptAt: null,
        summary: null,
        changed: true,
        ...v2,
      });
    });

    it('ignores a failure report from an attempt that has been superseded', async () => {
      const id = await addPendingSummary('a');
      await queries.claimPendingSummaries(CLAIM);
      await makeDue(id);
      await queries.claimPendingSummaries(CLAIM);

      await expect(
        queries.failSummary({ snapshotId: id, attempt: 1, error: 'late' }),
      ).resolves.toBe(false);

      expect((await load(id)).summaryStatus).toBe('pending');
    });
  });
});
