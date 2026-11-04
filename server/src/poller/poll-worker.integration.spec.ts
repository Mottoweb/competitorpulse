import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { Competitor } from '../competitors/competitor.entity';
import {
  FixtureListingSource,
  type Fixtures,
} from '../source/fixture-listing-source';
import type { Listing } from '../source/listing';
import type { FetchedListing, ListingSource } from '../source/listing-source';
import { SourceCursor } from '../source/source-cursor.entity';
import {
  createMigratedTestDatabase,
  dropTestDatabase,
  truncateAll,
} from '../testing/test-database';
import { PollWorker } from './poll-worker';
import type { PollerConfig } from './poller-config';
import { SnapshotQueries } from './snapshot-queries';
import { Snapshot } from './snapshot.entity';

const CONFIG: PollerConfig = {
  pollIntervalSeconds: 900,
  checkIntervalSeconds: 15,
  jitterRatio: 0.1,
  concurrency: 10,
  saveRetryDelaysMs: [0, 0],
};

function version(price: string): Listing {
  return { title: 'Acme', tagline: 'Fast', price, description: 'A listing' };
}

const fixtures: Fixtures = {
  acme: [version('v1'), version('v2'), version('v3'), version('v4')],
};

/** Records calls and overlap, and yields once so concurrent fetches really overlap. */
class RecordingSource implements ListingSource {
  readonly calls: string[] = [];
  maxInFlight = 0;
  private inFlight = 0;

  constructor(
    private readonly onFetch: (id: string) => Promise<void> = () =>
      Promise.resolve(),
  ) {}

  isKnown(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async fetchListing(id: string): Promise<FetchedListing> {
    this.calls.push(id);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      await this.onFetch(id);
      return { listing: version('v1'), markSaved: () => Promise.resolve() };
    } finally {
      this.inFlight -= 1;
    }
  }
}

describe('PollWorker', () => {
  let dataSource: DataSource;
  let queries: SnapshotQueries;

  function fixtureWorker(): { worker: PollWorker; source: FixtureListingSource } {
    const source = new FixtureListingSource(dataSource, fixtures);
    return { worker: new PollWorker(queries, source, CONFIG), source };
  }

  async function addCompetitors(...ids: string[]): Promise<void> {
    await dataSource.query(
      `INSERT INTO competitors (id) SELECT unnest($1::text[])`,
      [ids],
    );
  }

  async function makeAllDue(): Promise<void> {
    await dataSource.query(
      `UPDATE competitors SET next_poll_at = now() - interval '1 second'`,
    );
  }

  function snapshots(): Promise<Snapshot[]> {
    return dataSource.manager.find(Snapshot, { order: { id: 'ASC' } });
  }

  function idsOf(id: string): (row: Snapshot) => boolean {
    return (row) => row.competitorId === id;
  }

  beforeAll(async () => {
    Logger.overrideLogger(false);
    dataSource = await createMigratedTestDatabase('poll_worker');
    queries = new SnapshotQueries(dataSource);
  });

  afterAll(async () => {
    await dropTestDatabase(dataSource);
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('polling', () => {
    it('walks the stub from v1 to v4, then repeats v4', async () => {
      await addCompetitors('acme');
      const { worker } = fixtureWorker();

      for (let poll = 0; poll < 6; poll += 1) {
        await worker.check();
        await makeAllDue();
      }

      const rows = await snapshots();
      expect(rows.map((row) => row.price)).toEqual([
        'v1',
        'v2',
        'v3',
        'v4',
        'v4',
        'v4',
      ]);
      expect(rows.map((row) => row.changed)).toEqual([
        false,
        true,
        true,
        true,
        false,
        false,
      ]);
      expect(rows.map((row) => row.summaryStatus)).toEqual([
        'none',
        'pending',
        'pending',
        'pending',
        'none',
        'none',
      ]);
    });

    it('moves the next poll forward, so a second check polls nothing', async () => {
      await addCompetitors('acme');
      const source = new RecordingSource();
      const worker = new PollWorker(queries, source, CONFIG);

      await worker.check();
      await worker.check();

      expect(source.calls).toEqual(['acme']);
    });

    it('drains everything due in one check, within the concurrency cap', async () => {
      const ids = Array.from({ length: 25 }, (_, index) => `competitor-${index}`);
      await addCompetitors(...ids);
      const source = new RecordingSource();
      const worker = new PollWorker(queries, source, CONFIG);

      await worker.check();

      expect((await snapshots()).length).toBe(25);
      expect(source.maxInFlight).toBe(CONFIG.concurrency);
    });
  });

  describe('failures', () => {
    it('writes nothing for a failed fetch, keeps polling others, and tries again when next due', async () => {
      await addCompetitors('bad', 'good');
      let failing = true;
      const source = new RecordingSource((id) =>
        id === 'bad' && failing
          ? Promise.reject(new Error('fetch failed'))
          : Promise.resolve(),
      );
      const worker = new PollWorker(queries, source, CONFIG);

      await worker.check();

      const afterFailure = await snapshots();
      expect(afterFailure.map((row) => row.competitorId)).toEqual(['good']);
      expect(source.calls.filter((id) => id === 'bad')).toEqual(['bad']);

      failing = false;
      await makeAllDue();
      await worker.check();

      expect((await snapshots()).filter(idsOf('bad'))).toHaveLength(1);
    });

    it('survives a failed claim and can check again', async () => {
      await addCompetitors('acme');
      const { worker } = fixtureWorker();
      jest
        .spyOn(queries, 'claimDueCompetitors')
        .mockRejectedValueOnce(new Error('database down'));

      await expect(worker.check()).resolves.toBeUndefined();
      expect(await snapshots()).toHaveLength(0);

      await worker.check();

      expect(await snapshots()).toHaveLength(1);
    });

    it('retries a failed write without fetching again and skips no version', async () => {
      await addCompetitors('acme');
      const { worker, source } = fixtureWorker();
      const fetch = jest.spyOn(source, 'fetchListing');
      jest
        .spyOn(queries, 'saveSnapshot')
        .mockRejectedValueOnce(new Error('connection lost'));

      await worker.check();

      expect(fetch).toHaveBeenCalledTimes(1);
      expect((await snapshots()).map((row) => row.price)).toEqual(['v1']);

      await makeAllDue();
      await worker.check();

      expect((await snapshots()).map((row) => row.price)).toEqual(['v1', 'v2']);
    });

    it('rolls the snapshot back when the cursor advance fails, then retries', async () => {
      await addCompetitors('acme');
      const markSaved = jest
        .fn<Promise<void>, []>()
        .mockRejectedValueOnce(new Error('cursor write failed'))
        .mockResolvedValue(undefined);
      const source: ListingSource = {
        isKnown: () => Promise.resolve(true),
        fetchListing: () =>
          Promise.resolve({ listing: version('v1'), markSaved }),
      };

      await new PollWorker(queries, source, CONFIG).check();

      expect(markSaved).toHaveBeenCalledTimes(2);
      expect(await snapshots()).toHaveLength(1);
    });

    it('gives up after the retries and polls the same version next time', async () => {
      await addCompetitors('acme');
      const { worker } = fixtureWorker();
      const save = jest
        .spyOn(queries, 'saveSnapshot')
        .mockRejectedValue(new Error('connection lost'));

      await expect(worker.check()).resolves.toBeUndefined();

      expect(save).toHaveBeenCalledTimes(1 + CONFIG.saveRetryDelaysMs.length);
      expect(await snapshots()).toHaveLength(0);
      expect(await dataSource.manager.count(SourceCursor)).toBe(0);

      save.mockRestore();
      await makeAllDue();
      await worker.check();

      expect((await snapshots()).map((row) => row.price)).toEqual(['v1']);
    });

    it('drops the result when the competitor is deleted during the fetch', async () => {
      await addCompetitors('acme');
      const source = new RecordingSource(async (id) => {
        await dataSource.manager.delete(Competitor, { id });
      });
      const save = jest.spyOn(queries, 'saveSnapshot');

      await new PollWorker(queries, source, CONFIG).check();

      expect(save).toHaveBeenCalledTimes(1);
      expect(await snapshots()).toHaveLength(0);
    });
  });

  describe('concurrency and restarts', () => {
    it('does not double-poll across two workers', async () => {
      const ids = Array.from({ length: 30 }, (_, index) => `competitor-${index}`);
      await addCompetitors(...ids);
      const source = new RecordingSource();
      const first = new PollWorker(queries, source, CONFIG);
      const second = new PollWorker(queries, source, CONFIG);

      await Promise.all([first.check(), second.check()]);

      expect([...source.calls].sort()).toEqual([...ids].sort());
      expect(await snapshots()).toHaveLength(30);
    });

    it('does not overlap checks on one worker', async () => {
      await addCompetitors('acme');
      const source = new RecordingSource();
      const worker = new PollWorker(queries, source, CONFIG);
      const save = jest.spyOn(queries, 'claimDueCompetitors');

      await Promise.all([worker.check(), worker.check()]);

      expect(source.calls).toEqual(['acme']);
      // One claim that finds work and one that finds the queue empty.
      expect(save).toHaveBeenCalledTimes(2);
    });

    it('drops a fetch when the competitor is deleted and re-added during it', async () => {
      await addCompetitors('acme');
      const { worker, source } = fixtureWorker();
      await worker.check();
      await makeAllDue();
      const racing: ListingSource = {
        isKnown: () => source.isKnown('acme'),
        fetchListing: async (id) => {
          const fetched = await source.fetchListing(id);
          await dataSource.query(`DELETE FROM competitors WHERE id = $1`, [id]);
          await dataSource.query(
            // Not due, or this worker would claim it again and re-add it forever.
            `INSERT INTO competitors (id, created_at, next_poll_at)
             VALUES ($1, now() + interval '1 minute', now() + interval '1 hour')`,
            [id],
          );
          return fetched;
        },
      };

      await new PollWorker(queries, racing, CONFIG).check();

      // The delete removed the first snapshot, and the old fetch adds nothing.
      expect(await snapshots()).toHaveLength(0);

      await makeAllDue();
      await worker.check();

      const rows = await snapshots();
      expect(rows.map((row) => [row.price, row.changed])).toEqual([['v1', false]]);
    });

    it('does not create a false change after a restart', async () => {
      await addCompetitors('acme');

      for (let poll = 0; poll < 5; poll += 1) {
        await fixtureWorker().worker.check();
        await makeAllDue();
      }

      const rows = await snapshots();
      expect(rows.map((row) => row.price)).toEqual([
        'v1',
        'v2',
        'v3',
        'v4',
        'v4',
      ]);
      expect(rows.at(-1)?.changed).toBe(false);
    });
  });

  describe('logging', () => {
    it('logs what each poll found', async () => {
      const log = jest.spyOn(Logger.prototype, 'log');
      await addCompetitors('acme');
      const { worker } = fixtureWorker();

      for (let poll = 0; poll < 5; poll += 1) {
        await worker.check();
        await makeAllDue();
      }

      expect(log.mock.calls.map((call) => String(call[0]))).toEqual([
        'acme: first snapshot saved',
        'acme: changed, summary queued',
        'acme: changed, summary queued',
        'acme: changed, summary queued',
        'acme: no change',
      ]);
    });

    it('logs its schedule at startup', async () => {
      const log = jest.spyOn(Logger.prototype, 'log');
      const { worker } = fixtureWorker();

      worker.onApplicationBootstrap();
      await worker.beforeApplicationShutdown();

      expect(log).toHaveBeenCalledWith('Polling every 900s, checking every 15s');
    });
  });
});
