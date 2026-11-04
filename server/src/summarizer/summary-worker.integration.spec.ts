import { Logger } from '@nestjs/common';
import OpenAI from 'openai';
import type { DataSource } from 'typeorm';
import type { LlmClient } from '../llm/llm-client';
import { SdkLlmClient } from '../llm/llm-client';
import { parseLlmConfig, type LlmConfig } from '../llm/llm-config';
import { ProviderFailover } from '../llm/provider-failover';
import { PollWorker } from '../poller/poll-worker';
import { SnapshotQueries } from '../poller/snapshot-queries';
import { Snapshot } from '../poller/snapshot.entity';
import { FixtureListingSource } from '../source/fixture-listing-source';
import type { Listing } from '../source/listing';
import { MockLlm } from '../testing/mock-llm';
import {
  createMigratedTestDatabase,
  dropTestDatabase,
  truncateAll,
} from '../testing/test-database';
import type { SummarizerConfig } from './summarizer-config';
import { SummaryQueries } from './summary-queries';
import { SummaryWorker } from './summary-worker';

const CONFIG: SummarizerConfig = {
  checkIntervalSeconds: 15,
  concurrency: 5,
  claimRetrySeconds: 60,
  backoffBaseSeconds: 5,
  backoffMaxSeconds: 60,
  maxAttempts: 3,
  saveRetryDelaysMs: [0, 0],
};

function version(price: string): Listing {
  return { title: 'Acme', tagline: 'Fast', price, description: 'A listing' };
}

function apiError(status: number): Error {
  return new OpenAI.APIError(status, undefined, `HTTP ${status}`, new Headers());
}

describe('SummaryWorker', () => {
  let dataSource: DataSource;
  let queries: SummaryQueries;
  let first: MockLlm;
  let second: MockLlm;
  let noKey: MockLlm;
  let llm: LlmConfig;

  function realWorker(overrides: Partial<LlmConfig> = {}): SummaryWorker {
    const config = { ...llm, ...overrides };
    return new SummaryWorker(
      queries,
      new ProviderFailover(config),
      new SdkLlmClient(config),
      CONFIG,
    );
  }

  function fakeWorker(client: LlmClient): SummaryWorker {
    return new SummaryWorker(queries, new ProviderFailover(llm), client, CONFIG);
  }

  /** A competitor with a first snapshot and a changed one waiting for its summary. */
  async function addPending(...ids: string[]): Promise<void> {
    await dataSource.query(
      `INSERT INTO competitors (id) SELECT unnest($1::text[])`,
      [ids],
    );
    await dataSource.query(
      `INSERT INTO snapshots (competitor_id, fetched_at, title, tagline, price,
         description, content_hash, changed, summary_status, summary_next_attempt_at)
       SELECT id, now(), 'Acme', 'Fast', v.price, 'A listing', v.hash, v.changed,
         v.status::summary_status, v.due
       FROM unnest($1::text[]) AS id
       CROSS JOIN (VALUES
         ('$39/mo', 'a', false, 'none', NULL::timestamptz, 1),
         ('$29/mo', 'b', true, 'pending', now() - interval '1 second', 2)
       ) AS v(price, hash, changed, status, due, position)
       ORDER BY id, v.position`,
      [ids],
    );
  }

  async function makeAllDue(): Promise<void> {
    await dataSource.query(
      `UPDATE snapshots SET summary_next_attempt_at = now() - interval '1 second'
       WHERE summary_status = 'pending'`,
    );
    await dataSource.query(
      `UPDATE competitors SET next_poll_at = now() - interval '1 second'`,
    );
  }

  function changedSnapshots(): Promise<Snapshot[]> {
    return dataSource.manager.find(Snapshot, {
      where: { changed: true },
      order: { id: 'ASC' },
    });
  }

  async function onlyChanged(): Promise<Snapshot> {
    const [row] = await changedSnapshots();
    if (row === undefined) {
      throw new Error('No changed snapshot');
    }
    return row;
  }

  async function callCounts(): Promise<number[]> {
    return Promise.all([first.callCount(), second.callCount(), noKey.callCount()]);
  }

  beforeAll(async () => {
    Logger.overrideLogger(false);
    dataSource = await createMigratedTestDatabase('summary_worker');
    queries = new SummaryQueries(dataSource);
    [first, second, noKey] = await Promise.all([
      MockLlm.start(),
      MockLlm.start(),
      MockLlm.start(),
    ]);
    llm = parseLlmConfig({
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: first.baseUrl,
      OPENAI_API_KEY: 'test-key',
      OPENAI_BASE_URL: second.baseUrl,
      // Pointed at a real server but given no key, so a call would show up.
      GROQ_BASE_URL: noKey.baseUrl,
    });
  });

  afterAll(async () => {
    [first, second, noKey].forEach((mock) => {
      mock.stop();
    });
    await dropTestDatabase(dataSource);
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
    await Promise.all([first.reset(), second.reset(), noKey.reset()]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('summaries', () => {
    it('makes no call for a first or unchanged snapshot and exactly one per change', async () => {
      await dataSource.query(`INSERT INTO competitors (id) VALUES ('acme')`);
      const source = new FixtureListingSource(dataSource, {
        acme: [version('v1'), version('v2'), version('v3'), version('v4')],
      });
      const poller = new PollWorker(new SnapshotQueries(dataSource), source, {
        pollIntervalSeconds: 900,
        checkIntervalSeconds: 15,
        jitterRatio: 0,
        concurrency: 10,
        saveRetryDelaysMs: [],
      });
      const worker = realWorker();
      const counts: number[] = [];

      // Sequential on purpose: each poll builds on the one before it.
      for (let poll = 0; poll < 6; poll += 1) {
        await poller.check();
        await worker.check();
        await worker.check();
        counts.push(await first.callCount());
        await makeAllDue();
      }

      expect(counts).toEqual([0, 1, 2, 3, 3, 3]);
    });

    it('saves the summary, provider and model on the snapshot', async () => {
      await addPending('acme');

      await realWorker().check();

      const row = await onlyChanged();
      expect(row.summaryStatus).toBe('done');
      expect(row.summary).toContain('Changed fields: price');
      expect(row.summaryProvider).toBe('deepseek');
      expect(row.summaryModel).toBe('deepseek-chat');
      expect(row.summaryNextAttemptAt).toBeNull();
    });

    it('drains everything pending in one check, within the concurrency cap', async () => {
      const ids = Array.from({ length: 12 }, (_, index) => `competitor-${index}`);
      await addPending(...ids);
      let inFlight = 0;
      let maxInFlight = 0;
      const client: LlmClient = {
        complete: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setImmediate(resolve));
          inFlight -= 1;
          return 'A summary.';
        },
      };

      await fakeWorker(client).check();

      const rows = await changedSnapshots();
      expect(rows.map((row) => row.summaryStatus)).toEqual(
        ids.map(() => 'done'),
      );
      expect(maxInFlight).toBe(CONFIG.concurrency);
    });
  });

  describe('failover', () => {
    it('moves to the next provider after a failure, and never calls one without a key', async () => {
      await addPending('acme');
      await first.configure({ failNext: 1 });
      const worker = realWorker();

      await worker.check();

      const failed = await onlyChanged();
      expect(failed.summaryStatus).toBe('pending');
      expect(failed.summaryAttempts).toBe(1);
      expect(failed.summaryError).toContain('deepseek');
      expect(failed.price).toBe('$29/mo');
      expect(await callCounts()).toEqual([0, 0, 0]);

      await makeAllDue();
      await worker.check();

      const row = await onlyChanged();
      expect(row.summaryStatus).toBe('done');
      expect(row.summaryProvider).toBe('openai');
      expect(row.summaryError).toBeNull();
      expect(await callCounts()).toEqual([0, 1, 0]);
    });

    it('backs off after a transient failure, so an immediate check calls nothing', async () => {
      await addPending('acme');
      const complete = jest
        .fn<Promise<string>, []>()
        .mockRejectedValue(apiError(429));
      const worker = fakeWorker({ complete });

      await worker.check();
      await worker.check();

      expect(complete).toHaveBeenCalledTimes(1);
      const row = await onlyChanged();
      expect(row.summaryStatus).toBe('pending');
      expect(row.summaryNextAttemptAt?.getTime()).toBeGreaterThan(Date.now());
    });

    it('moves to the next provider without waiting after a bad key', async () => {
      await addPending('acme');
      const called: string[] = [];
      const client: LlmClient = {
        complete: (provider) => {
          called.push(provider.name);
          return provider.name === 'deepseek'
            ? Promise.reject(apiError(401))
            : Promise.resolve('A summary.');
        },
      };

      await fakeWorker(client).check();

      expect(called).toEqual(['deepseek', 'openai']);
      const row = await onlyChanged();
      expect(row.summaryStatus).toBe('done');
      expect(row.summaryProvider).toBe('openai');
    });

    it('moves to the next provider after a 400, because only one may be at fault', async () => {
      await addPending('acme');
      const complete = jest
        .fn<Promise<string>, []>()
        .mockRejectedValueOnce(apiError(400))
        .mockResolvedValue('A summary');

      const worker = fakeWorker({ complete });
      await worker.check();
      await worker.check();

      expect(complete).toHaveBeenCalledTimes(2);
      const row = await onlyChanged();
      expect(row.summaryStatus).toBe('done');
      expect(row.summaryAttempts).toBe(2);
    });

    it('ends as failed when a 400 repeats until attempts run out', async () => {
      await addPending('acme');
      const complete = jest
        .fn<Promise<string>, []>()
        .mockRejectedValue(apiError(400));

      const worker = fakeWorker({ complete });
      await worker.check();
      await worker.check();
      await worker.check();

      expect(complete).toHaveBeenCalledTimes(CONFIG.maxAttempts);
      const row = await onlyChanged();
      expect(row.summaryStatus).toBe('failed');
      expect(row.summaryError).toContain('HTTP 400');
    });

    it('retries saving a summary, so a brief database error wastes no paid call', async () => {
      await addPending('acme');
      const complete = jest.fn<Promise<string>, []>().mockResolvedValue('A summary');
      jest
        .spyOn(queries, 'completeSummary')
        .mockRejectedValueOnce(new Error('connection lost'));

      await fakeWorker({ complete }).check();

      expect(complete).toHaveBeenCalledTimes(1);
      const row = await onlyChanged();
      expect(row.summaryStatus).toBe('done');
      expect(row.summaryAttempts).toBe(1);
    });

    it('ends as failed once attempts run out, with the snapshot intact', async () => {
      await addPending('acme');
      await Promise.all([
        first.configure({ failNext: 99 }),
        second.configure({ failNext: 99 }),
      ]);
      const worker = realWorker();

      // Sequential on purpose: each attempt waits for the last one's retry time.
      for (let attempt = 0; attempt < CONFIG.maxAttempts + 2; attempt += 1) {
        await worker.check();
        await makeAllDue();
      }

      const row = await onlyChanged();
      expect(row.summaryStatus).toBe('failed');
      expect(row.summaryAttempts).toBe(CONFIG.maxAttempts);
      expect(row.summaryError).toContain('500');
      expect(row.summary).toBeNull();
      expect(row.summaryNextAttemptAt).toBeNull();
      expect(row).toMatchObject({
        title: 'Acme',
        tagline: 'Fast',
        price: '$29/mo',
        description: 'A listing',
        changed: true,
      });
    });
  });

  describe('slow calls', () => {
    it('aborts at the timeout, and polling continues during the call', async () => {
      // Its own server: a sleeping request still counts when it wakes, which
      // would disturb later tests on a shared one.
      const slow = await MockLlm.start();
      try {
        await slow.configure({ latencyMs: 5_000 });
        await addPending('acme');
        await dataSource.query(`INSERT INTO competitors (id) VALUES ('other')`);
        const worker = realWorker({
          timeoutMs: 500,
          providers: llm.providers.map((provider) => ({
            ...provider,
            baseUrl: slow.baseUrl,
          })),
        });
        const poller = new PollWorker(
          new SnapshotQueries(dataSource),
          new FixtureListingSource(dataSource, { other: [version('v1')] }),
          {
            pollIntervalSeconds: 900,
            checkIntervalSeconds: 15,
            jitterRatio: 0,
            concurrency: 10,
            saveRetryDelaysMs: [],
          },
        );
        // Only 'other' is due: the fixture source doesn't know 'acme'.
        await dataSource.query(
          `UPDATE competitors SET next_poll_at = now() + interval '1 hour'
           WHERE id = 'acme'`,
        );
        const started = Date.now();
        let summaryFinished = false;

        const summarizing = worker.check().then(() => {
          summaryFinished = true;
        });
        await poller.check();

        const polledDuringCall = !summaryFinished;
        await summarizing;

        expect(polledDuringCall).toBe(true);
        expect(
          await dataSource.manager.countBy(Snapshot, { competitorId: 'other' }),
        ).toBe(1);
        expect(Date.now() - started).toBeLessThan(4_000);
        const [row] = await dataSource.manager.findBy(Snapshot, {
          competitorId: 'acme',
          changed: true,
        });
        expect(row?.summaryStatus).toBe('pending');
        expect(row?.summaryError).toContain('deepseek');
      } finally {
        slow.stop();
      }
    });
  });

  describe('crashes', () => {
    const claim = (): ReturnType<SummaryQueries['claimPendingSummaries']> =>
      queries.claimPendingSummaries({
        limit: 5,
        retryAfterSeconds: 60,
        maxAttempts: CONFIG.maxAttempts,
      });

    it('leaves a crashed attempt alone until its retry time, then retries it on the next provider', async () => {
      await addPending('acme');
      await claim();
      const worker = realWorker();

      await worker.check();
      expect(await callCounts()).toEqual([0, 0, 0]);

      await makeAllDue();
      await worker.check();

      const row = await onlyChanged();
      expect(row.summaryStatus).toBe('done');
      expect(row.summaryProvider).toBe('openai');
      expect(row.summaryAttempts).toBe(2);
    });

    it('holds the attempt cap across crashes', async () => {
      await addPending('acme');

      // Sequential on purpose: each claim waits for the last one's retry time.
      for (let attempt = 0; attempt < CONFIG.maxAttempts; attempt += 1) {
        await claim();
        await makeAllDue();
      }
      await realWorker().check();

      const row = await onlyChanged();
      expect(row.summaryStatus).toBe('failed');
      expect(row.summaryAttempts).toBe(CONFIG.maxAttempts);
      expect(await callCounts()).toEqual([0, 0, 0]);
    });
  });

  describe('concurrency', () => {
    it('does not double-summarise across two workers', async () => {
      const ids = Array.from({ length: 12 }, (_, index) => `competitor-${index}`);
      await addPending(...ids);

      await Promise.all([realWorker().check(), realWorker().check()]);

      expect(await first.callCount()).toBe(12);
      const rows = await changedSnapshots();
      expect(rows.every((row) => row.summaryAttempts === 1)).toBe(true);
      expect(rows.every((row) => row.summaryStatus === 'done')).toBe(true);
    });

    it('does not overlap checks on one worker', async () => {
      await addPending('acme');
      const worker = realWorker();

      await Promise.all([worker.check(), worker.check()]);

      expect(await first.callCount()).toBe(1);
      expect((await onlyChanged()).summaryStatus).toBe('done');
    });
  });

  describe('database failures', () => {
    it('survives a failed claim and can check again', async () => {
      await addPending('acme');
      const worker = realWorker();
      jest
        .spyOn(queries, 'claimPendingSummaries')
        .mockRejectedValueOnce(new Error('database down'));

      await expect(worker.check()).resolves.toBeUndefined();
      await worker.check();

      expect((await onlyChanged()).summaryStatus).toBe('done');
    });

    it('survives a failed save, and the row comes back after its retry time', async () => {
      await addPending('acme');
      const worker = realWorker();
      // The first try and both of its retries.
      jest
        .spyOn(queries, 'completeSummary')
        .mockRejectedValueOnce(new Error('connection lost'))
        .mockRejectedValueOnce(new Error('connection lost'))
        .mockRejectedValueOnce(new Error('connection lost'));

      await expect(worker.check()).resolves.toBeUndefined();

      const lost = await onlyChanged();
      expect(lost.summaryStatus).toBe('pending');
      expect(lost.summaryError).toBeNull();
      expect(await first.callCount()).toBe(1);

      await makeAllDue();
      await worker.check();

      expect((await onlyChanged()).summaryStatus).toBe('done');
    });

    it('drops the result when the competitor is deleted during the call', async () => {
      await addPending('acme');
      const complete = jest.fn(async () => {
        await dataSource.query(`DELETE FROM competitors WHERE id = 'acme'`);
        return 'A summary.';
      });

      await expect(fakeWorker({ complete }).check()).resolves.toBeUndefined();

      expect(complete).toHaveBeenCalledTimes(1);
      expect(await dataSource.manager.count(Snapshot)).toBe(0);
    });
  });

  describe('logging', () => {
    it('logs a saved summary with its competitor, provider and attempt', async () => {
      const log = jest.spyOn(Logger.prototype, 'log');
      await addPending('acme');

      await realWorker().check();

      const row = await onlyChanged();
      expect(row.summaryStatus).toBe('done');
      expect(log).toHaveBeenCalledWith(
        `acme: summary saved by ${row.summaryProvider} (${row.summaryModel}) on attempt 1`,
      );
    });

    it('logs when a failed summary will retry', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      await addPending('acme');

      await fakeWorker({
        complete: jest.fn().mockRejectedValue(apiError(500)),
      }).check();

      expect(warn).toHaveBeenCalledWith('acme: summary retries in 5s');
    });

    it('logs when a summary gives up', async () => {
      const error = jest.spyOn(Logger.prototype, 'error');
      await addPending('acme');
      await dataSource.query(
        `UPDATE snapshots SET summary_attempts = 2 WHERE summary_status = 'pending'`,
      );

      await fakeWorker({
        complete: jest.fn().mockRejectedValue(apiError(400)),
      }).check();

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('acme: summary gave up after attempt 3'),
      );
    });

    it('logs its schedule at startup', async () => {
      const log = jest.spyOn(Logger.prototype, 'log');
      const worker = realWorker();

      worker.onApplicationBootstrap();
      await worker.beforeApplicationShutdown();

      expect(log).toHaveBeenCalledWith('Checking for pending summaries every 15s');
    });
  });
});
