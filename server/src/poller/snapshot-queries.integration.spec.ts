import type { DataSource } from 'typeorm';
import { Competitor } from '../competitors/competitor.entity';
import { SourceCursor } from '../source/source-cursor.entity';
import type { Listing } from '../source/listing';
import {
  createMigratedTestDatabase,
  dropTestDatabase,
  truncateAll,
} from '../testing/test-database';
import {
  SnapshotQueries,
  type ClaimDueCompetitorsInput,
} from './snapshot-queries';
import { Snapshot } from './snapshot.entity';

const INTERVAL = { intervalSeconds: 900, jitterRatio: 0.1 };

const v1: Listing = {
  title: 'Acme CRM',
  tagline: 'Simple CRM',
  price: '$29/mo',
  description: 'Track leads.',
};
const v2: Listing = { ...v1, price: '$39/mo' };

interface SecondsRow {
  id: string;
  seconds: number;
}

describe('SnapshotQueries', () => {
  let dataSource: DataSource;
  let queries: SnapshotQueries;

  async function addCompetitors(...ids: string[]): Promise<void> {
    await dataSource.query(
      `INSERT INTO competitors (id) SELECT unnest($1::text[])`,
      [ids],
    );
  }

  async function secondsUntilNextPoll(): Promise<SecondsRow[]> {
    return dataSource.query<SecondsRow[]>(
      `SELECT id, EXTRACT(EPOCH FROM next_poll_at - now())::float AS seconds
       FROM competitors ORDER BY id`,
    );
  }

  /** Most claim tests only care which competitors were claimed. */
  async function claimIds(
    input: ClaimDueCompetitorsInput,
  ): Promise<string[]> {
    const claimed = await queries.claimDueCompetitors(input);
    return claimed.map(({ id }) => id);
  }

  async function deleteAndReAdd(id: string): Promise<void> {
    await dataSource.query(`DELETE FROM competitors WHERE id = $1`, [id]);
    await dataSource.query(
      `INSERT INTO competitors (id, created_at) VALUES ($1, now() + interval '1 minute')`,
      [id],
    );
  }

  function save(competitorId: string, listing: Listing) {
    return queries.saveSnapshot({
      competitorId,
      listing,
      fetchedAt: new Date('2026-01-01T00:00:00Z'),
    });
  }

  beforeAll(async () => {
    dataSource = await createMigratedTestDatabase('snapshot_queries');
    queries = new SnapshotQueries(dataSource);
  });

  afterAll(async () => {
    await dropTestDatabase(dataSource);
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
  });

  describe('claimDueCompetitors', () => {
    it('returns when each claimed competitor was created', async () => {
      await addCompetitors('a');
      const [row] = await dataSource.manager.findBy(Competitor, { id: 'a' });

      const claimed = await queries.claimDueCompetitors({
        limit: 1,
        ...INTERVAL,
      });

      expect(claimed).toEqual([{ id: 'a', createdAt: row?.createdAt }]);
    });

    it('claims only competitors that are due, most overdue first', async () => {
      await addCompetitors('recent', 'oldest', 'not-due');
      await dataSource.query(
        `UPDATE competitors SET next_poll_at = CASE id
           WHEN 'recent' THEN now() - interval '1 minute'
           WHEN 'oldest' THEN now() - interval '1 hour'
           ELSE now() + interval '1 hour' END`,
      );

      await expect(
        claimIds({ limit: 10, ...INTERVAL }),
      ).resolves.toEqual(['oldest', 'recent']);
    });

    it('claims no more than the limit', async () => {
      await addCompetitors('a', 'b', 'c');

      const claimed = await claimIds({
        limit: 2,
        ...INTERVAL,
      });

      expect(claimed).toHaveLength(2);
    });

    it('moves the claimed competitors to one interval from now, within the jitter', async () => {
      await addCompetitors('a');
      await dataSource.query(
        `UPDATE competitors SET next_poll_at = now() - interval '1 day'`,
      );

      await claimIds({ limit: 10, ...INTERVAL });

      const [row] = await secondsUntilNextPoll();
      expect(row?.seconds).toBeGreaterThanOrEqual(810 - 5);
      expect(row?.seconds).toBeLessThanOrEqual(990 + 5);
    });

    it('polls an overdue competitor once rather than catching up', async () => {
      await addCompetitors('a');
      await dataSource.query(
        `UPDATE competitors SET next_poll_at = now() - interval '1 day'`,
      );

      const first = await claimIds({
        limit: 10,
        ...INTERVAL,
      });
      const second = await claimIds({
        limit: 10,
        ...INTERVAL,
      });

      expect(first).toEqual(['a']);
      expect(second).toEqual([]);
    });

    it('gives each claimed competitor its own jitter', async () => {
      const ids = Array.from({ length: 20 }, (_, index) => `c${index}`);
      await addCompetitors(...ids);

      await claimIds({ limit: 20, ...INTERVAL });

      const rows = await secondsUntilNextPoll();
      expect(new Set(rows.map((row) => row.seconds)).size).toBeGreaterThan(1);
    });

    it('skips a row locked by another transaction instead of waiting for it', async () => {
      await addCompetitors('locked', 'free');
      const holder = dataSource.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      try {
        await holder.query(
          `SELECT id FROM competitors WHERE id = 'locked' FOR UPDATE`,
        );

        await expect(
          claimIds({ limit: 10, ...INTERVAL }),
        ).resolves.toEqual(['free']);
      } finally {
        await holder.rollbackTransaction();
        await holder.release();
      }
    });

    it('never gives the same competitor to two concurrent claims', async () => {
      const ids = Array.from({ length: 50 }, (_, index) => `c${index}`);
      await addCompetitors(...ids);

      const claims = await Promise.all(
        Array.from({ length: 5 }, () =>
          claimIds({ limit: 20, ...INTERVAL }),
        ),
      );

      const claimed = claims.flat();
      expect(new Set(claimed).size).toBe(claimed.length);
      expect([...claimed].sort()).toEqual([...ids].sort());
    });
  });

  describe('saveSnapshot', () => {
    it('stores the first snapshot as unchanged, with no summary needed', async () => {
      await addCompetitors('a');

      const saved = await save('a', v1);

      expect(saved?.id).toMatch(/^\d+$/);
      expect(saved?.changed).toBe(false);
      const rows = await dataSource.manager.find(Snapshot);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        competitorId: 'a',
        ...v1,
        fetchedAt: new Date('2026-01-01T00:00:00Z'),
        changed: false,
        summary: null,
        summaryStatus: 'none',
        summaryAttempts: 0,
        summaryNextAttemptAt: null,
      });
      expect(rows[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('stores an identical listing as unchanged, keeping every snapshot', async () => {
      await addCompetitors('a');
      await save('a', v1);

      const saved = await save('a', v1);

      expect(saved?.changed).toBe(false);
      const rows = await dataSource.manager.find(Snapshot);
      expect(rows).toHaveLength(2);
      expect(rows[1]?.summaryStatus).toBe('none');
    });

    it('treats a whitespace-only difference as unchanged but stores the raw text', async () => {
      await addCompetitors('a');
      await save('a', v1);

      const saved = await save('a', { ...v1, title: ' Acme  CRM ' });

      expect(saved?.changed).toBe(false);
      const stored = await queries.listTimeline('a');
      expect(stored[0]?.title).toBe(' Acme  CRM ');
    });

    it('marks a real change as changed, with a summary due now', async () => {
      await addCompetitors('a');
      await save('a', v1);

      const saved = await save('a', v2);

      expect(saved?.changed).toBe(true);
      const rows = await dataSource.query<{ due: boolean }[]>(
        `SELECT summary_next_attempt_at <= now() AS due FROM snapshots
         WHERE summary_status = 'pending' AND summary_attempts = 0 AND changed`,
      );
      expect(rows).toEqual([{ due: true }]);
    });

    it('compares against the latest snapshot, not any earlier one', async () => {
      await addCompetitors('a');
      await save('a', v1);
      await save('a', v2);

      const saved = await save('a', v1);

      expect(saved?.changed).toBe(true);
    });

    it('compares only against the same competitor', async () => {
      await addCompetitors('a', 'b');
      await save('a', v1);

      const saved = await save('b', v2);

      expect(saved?.changed).toBe(false);
    });

    it('drops the result when the competitor was deleted during the fetch', async () => {
      await expect(save('deleted', v1)).resolves.toBeNull();
      await expect(dataSource.manager.count(Snapshot)).resolves.toBe(0);
    });

    it('saves when the competitor is the one that was claimed', async () => {
      await addCompetitors('a');
      const [claimed] = await queries.claimDueCompetitors({
        limit: 1,
        ...INTERVAL,
      });

      const saved = await queries.saveSnapshot({
        competitorId: 'a',
        listing: v1,
        fetchedAt: new Date(),
        claimedCreatedAt: claimed?.createdAt,
      });

      expect(saved).not.toBeNull();
      await expect(dataSource.manager.count(Snapshot)).resolves.toBe(1);
    });

    it('drops a save for a competitor deleted and re-added since the claim', async () => {
      await addCompetitors('a');
      const [claimed] = await queries.claimDueCompetitors({
        limit: 1,
        ...INTERVAL,
      });
      await deleteAndReAdd('a');
      const inTransaction = jest.fn(() => Promise.resolve());

      const saved = await queries.saveSnapshot({
        competitorId: 'a',
        listing: v1,
        fetchedAt: new Date(),
        claimedCreatedAt: claimed?.createdAt,
        inTransaction,
      });

      expect(saved).toBeNull();
      expect(inTransaction).not.toHaveBeenCalled();
      await expect(dataSource.manager.count(Snapshot)).resolves.toBe(0);
    });

    it('commits inTransaction writes together with the snapshot', async () => {
      await addCompetitors('a');

      await queries.saveSnapshot({
        competitorId: 'a',
        listing: v1,
        fetchedAt: new Date(),
        inTransaction: async (tx) => {
          await tx.insert(SourceCursor, { competitorId: 'a', position: 1 });
        },
      });

      await expect(dataSource.manager.count(Snapshot)).resolves.toBe(1);
      await expect(dataSource.manager.count(SourceCursor)).resolves.toBe(1);
    });

    it('rolls the snapshot back when inTransaction fails, so a retry is safe', async () => {
      await addCompetitors('a');
      await save('a', v1);

      await expect(
        queries.saveSnapshot({
          competitorId: 'a',
          listing: v2,
          fetchedAt: new Date(),
          inTransaction: () => Promise.reject(new Error('cursor write failed')),
        }),
      ).rejects.toThrow('cursor write failed');

      await expect(dataSource.manager.count(Snapshot)).resolves.toBe(1);
      const retried = await save('a', v2);
      expect(retried?.changed).toBe(true);
    });

    it('serialises concurrent saves for one competitor, so each sees the one before', async () => {
      await addCompetitors('a');

      const saved = await Promise.all([save('a', v1), save('a', v2)]);

      // Without the competitor row lock both would see no previous snapshot.
      expect(saved.map((row) => row?.changed).sort()).toEqual([false, true]);
    });
  });

  describe('listTimeline', () => {
    it('returns one competitor newest first, with its fields and summary state', async () => {
      await addCompetitors('a', 'b');
      await save('a', v1);
      await save('b', v1);
      await save('a', v2);

      const timeline = await queries.listTimeline('a');

      expect(
        timeline.map((row) => [row.competitorId, row.price, row.summaryStatus]),
      ).toEqual([
        ['a', '$39/mo', 'pending'],
        ['a', '$29/mo', 'none'],
      ]);
    });

    it('returns the full history without a limit and the newest rows with one', async () => {
      await addCompetitors('a');
      await save('a', v1);
      await save('a', v2);
      await save('a', v1);

      await expect(queries.listTimeline('a')).resolves.toHaveLength(3);
      const limited = await queries.listTimeline('a', 1);
      expect(limited.map((row) => row.price)).toEqual(['$29/mo']);
      expect(limited[0]?.changed).toBe(true);
    });

    it('returns an empty list for a competitor with no snapshots', async () => {
      await expect(queries.listTimeline('none')).resolves.toEqual([]);
    });
  });
});
