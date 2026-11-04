import 'reflect-metadata';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { AppModule } from '../app.module';
import { PROVIDER_NAMES } from '../llm/providers';
import { PollWorker } from '../poller/poll-worker';
import { Snapshot } from '../poller/snapshot.entity';
import { SourceCursor } from '../source/source-cursor.entity';
import { SummaryWorker } from '../summarizer/summary-worker';
import { MockLlm } from '../testing/mock-llm';
import {
  createMigratedTestDatabase,
  dropTestDatabase,
  truncateAll,
} from '../testing/test-database';
import { Competitor } from './competitor.entity';
import {
  SUMMARY_STATUSES,
  type Competitor as CompetitorContract,
  type Snapshot as SnapshotContract,
  type SummaryStatus,
} from './contract';
import { specViolations } from '../testing/openapi-contract';
import { CompetitorsService } from './competitors.service';

// Strict and typed against the server's contract: a missing or extra field fails
// at run time, and a contract change breaks the compile here.
const competitorSchema: z.ZodType<CompetitorContract> = z.strictObject({
  id: z.string(),
});
const snapshotSchema: z.ZodType<SnapshotContract> = z.strictObject({
  fetchedAt: z.iso.datetime(),
  title: z.string(),
  tagline: z.string(),
  price: z.string(),
  description: z.string(),
  changed: z.boolean(),
  summary: z.string().nullable(),
  summaryStatus: z.enum(SUMMARY_STATUSES),
  summaryProvider: z.string().nullable(),
  summaryModel: z.string().nullable(),
});
const snapshotListSchema = z.array(snapshotSchema);
const errorSchema = z.object({ message: z.string() });

const ENV_OVERRIDES = {
  MOCK_API_KEY: 'test-key',
  // Tests run the workers by calling check(), so the timers must stay quiet.
  CHECK_INTERVAL_SECONDS: '3600',
};

describe('competitors API', () => {
  let dataSource: DataSource;
  let mock: MockLlm;
  let app: INestApplication;
  let baseUrl: string;
  const originalEnv = { ...process.env };

  async function track(...ids: string[]): Promise<void> {
    await dataSource.manager.insert(
      Competitor,
      ids.map((id) => ({ id })),
    );
  }

  async function insertSnapshot(
    competitorId: string,
    fields: {
      price?: string;
      fetchedAt?: Date;
      changed?: boolean;
      summary?: string | null;
      summaryStatus?: SummaryStatus;
      summaryProvider?: string | null;
      summaryModel?: string | null;
      summaryError?: string | null;
    } = {},
  ): Promise<void> {
    await dataSource.manager.insert(Snapshot, {
      competitorId,
      fetchedAt: new Date('2026-09-10T12:00:00.000Z'),
      title: 'Acme',
      tagline: 'Fast',
      price: '$29',
      description: 'Text',
      contentHash: 'hash',
      changed: false,
      summaryStatus: 'none',
      ...fields,
    });
  }

  async function pollAll(): Promise<void> {
    await dataSource.query(
      `UPDATE competitors SET next_poll_at = now() - interval '1 second'`,
    );
    await app.get(PollWorker, { strict: false }).check();
  }

  async function getSnapshots(id: string): Promise<SnapshotContract[]> {
    const response = await request(baseUrl)
      .get(`/api/competitors/${id}/snapshots`)
      .expect(200);
    return snapshotListSchema.parse(response.body);
  }

  beforeAll(async () => {
    Logger.overrideLogger(false);
    dataSource = await createMigratedTestDatabase('competitors_api');
    mock = await MockLlm.start();
    // Tests never call a real provider, whatever keys the shell has set.
    PROVIDER_NAMES.forEach((name) => {
      delete process.env[`${name.toUpperCase()}_API_KEY`];
    });
    delete process.env.LLM_PROVIDER_ORDER;
    Object.assign(process.env, ENV_OVERRIDES, {
      POSTGRES_DB: String(dataSource.options.database),
      MOCK_BASE_URL: mock.baseUrl,
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
    mock.stop();
    await dropTestDatabase(dataSource);
    process.env = originalEnv;
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
    await mock.reset();
  });

  describe('when Postgres is unavailable', () => {
    function connectionRefused(): Error {
      return Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
        code: 'ECONNREFUSED',
      });
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('returns 503 with a message, and does not leak the error', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      jest
        .spyOn(app.get(CompetitorsService, { strict: false }), 'list')
        .mockRejectedValueOnce(connectionRefused());

      const response = await request(baseUrl).get('/api/competitors').expect(503);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));

      expect(response.text).not.toContain('ECONNREFUSED');
      expect(response.body).toEqual({
        statusCode: 503,
        message: 'The database is unavailable. Try again shortly.',
        error: 'Service Unavailable',
      });
      expect(specViolations('get', '/api/competitors', response)).toEqual([]);
    });

    it('still returns 500 for any other error', async () => {
      jest
        .spyOn(app.get(CompetitorsService, { strict: false }), 'list')
        .mockRejectedValueOnce(new Error('a bug'));

      await request(baseUrl).get('/api/competitors').expect(500);
    });
  });

  describe('GET /api/competitors', () => {
    it('returns an empty list when nothing is tracked', async () => {
      const response = await request(baseUrl).get('/api/competitors').expect(200);

      expect(response.body).toEqual([]);
    });

    it('returns only the id of each competitor, in a stable order', async () => {
      await track('north-analytics', 'acme-crm');

      const response = await request(baseUrl).get('/api/competitors').expect(200);

      expect(z.array(competitorSchema).parse(response.body)).toEqual([
        { id: 'acme-crm' },
        { id: 'north-analytics' },
      ]);
    });
  });

  describe('POST /api/competitors', () => {
    it('returns 201 and tracks the competitor', async () => {
      const response = await request(baseUrl)
        .post('/api/competitors')
        .send({ id: 'acme-crm' })
        .expect(201);

      expect(response.body).toEqual({ id: 'acme-crm' });
      expect(await dataSource.manager.findBy(Competitor, {})).toEqual([
        expect.objectContaining({ id: 'acme-crm' }),
      ]);
    });

    it('makes the competitor due immediately', async () => {
      await request(baseUrl)
        .post('/api/competitors')
        .send({ id: 'acme-crm' })
        .expect(201);

      await app.get(PollWorker, { strict: false }).check();

      expect((await getSnapshots('acme-crm')).map((row) => row.price)).toEqual([
        '$29/mo',
      ]);
    });

    it.each<[string, object]>([
      ['an empty object', {}],
      ['an array', []],
      ['a numeric id', { id: 123 }],
      ['an empty id', { id: '' }],
      ['an id with capitals', { id: 'Acme-CRM' }],
      ['an id with a space', { id: 'acme crm' }],
      ['an id with surrounding space', { id: ' acme-crm' }],
      ['an id with a slash', { id: 'acme/crm' }],
      ['an id with a NUL byte', { id: 'acme\u0000crm' }],
      ['an id that is too long', { id: 'a'.repeat(101) }],
    ])('returns 400 for %s', async (_name, body) => {
      await request(baseUrl).post('/api/competitors').send(body).expect(400);

      expect(await dataSource.manager.count(Competitor)).toBe(0);
    });

    it('returns 400 with no body', async () => {
      await request(baseUrl).post('/api/competitors').expect(400);
    });

    it('returns 400 for malformed JSON', async () => {
      await request(baseUrl)
        .post('/api/competitors')
        .set('Content-Type', 'application/json')
        .send('{"id":')
        .expect(400);
    });

    it.each(['not-a-real-one', 'constructor'])(
      'returns 422 for %s, which the source does not know',
      async (id) => {
        const response = await request(baseUrl)
          .post('/api/competitors')
          .send({ id })
          .expect(422);

        expect(errorSchema.parse(response.body).message).toContain(id);
        expect(await dataSource.manager.count(Competitor)).toBe(0);
      },
    );

    it('returns 409 for an id already tracked, and keeps its schedule', async () => {
      await dataSource.query(`INSERT INTO competitors (id, next_poll_at)
        VALUES ('acme-crm', '2030-01-01T00:00:00Z')`);

      const response = await request(baseUrl)
        .post('/api/competitors')
        .send({ id: 'acme-crm' })
        .expect(409);

      expect(errorSchema.parse(response.body).message).toContain('acme-crm');
      const rows = await dataSource.manager.findBy(Competitor, {});
      expect(rows.map((row) => row.nextPollAt.toISOString())).toEqual([
        '2030-01-01T00:00:00.000Z',
      ]);
    });

    it('lets exactly one of several concurrent adds succeed', async () => {
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(baseUrl).post('/api/competitors').send({ id: 'acme-crm' }),
        ),
      );

      expect(responses.map((response) => response.status).sort()).toEqual([
        201, 409, 409, 409, 409,
      ]);
    });
  });

  describe('DELETE /api/competitors/:id', () => {
    it('returns 204 with no body and removes the competitor', async () => {
      await track('acme-crm', 'north-analytics');

      const response = await request(baseUrl)
        .delete('/api/competitors/acme-crm')
        .expect(204);

      expect(response.text).toBe('');
      const rows = await dataSource.manager.findBy(Competitor, {});
      expect(rows.map((row) => row.id)).toEqual(['north-analytics']);
    });

    it('removes its snapshots and cursor, and leaves other competitors alone', async () => {
      await track('acme-crm', 'north-analytics');
      await pollAll();

      await request(baseUrl).delete('/api/competitors/acme-crm').expect(204);

      const snapshots = await dataSource.manager.findBy(Snapshot, {});
      expect(snapshots.map((row) => row.competitorId)).toEqual([
        'north-analytics',
      ]);
      const cursors = await dataSource.manager.findBy(SourceCursor, {});
      expect(cursors.map((row) => row.competitorId)).toEqual([
        'north-analytics',
      ]);
    });

    it('starts again at v1 when the competitor is added back', async () => {
      await track('acme-crm');
      await pollAll();
      await pollAll();
      expect((await getSnapshots('acme-crm')).map((row) => row.price)).toEqual([
        '$39/mo',
        '$29/mo',
      ]);

      await request(baseUrl).delete('/api/competitors/acme-crm').expect(204);
      await request(baseUrl)
        .post('/api/competitors')
        .send({ id: 'acme-crm' })
        .expect(201);
      await pollAll();

      expect((await getSnapshots('acme-crm')).map((row) => row.price)).toEqual([
        '$29/mo',
      ]);
    });

    it.each(['untracked', 'a%00b'])('returns 404 for %s', async (id) => {
      await request(baseUrl).delete(`/api/competitors/${id}`).expect(404);
    });
  });

  describe('GET /api/competitors/:id/snapshots', () => {
    it.each(['untracked', 'a%00b'])('returns 404 for %s', async (id) => {
      await request(baseUrl).get(`/api/competitors/${id}/snapshots`).expect(404);
    });

    it('returns an empty list for a competitor not polled yet', async () => {
      await track('acme-crm');

      expect(await getSnapshots('acme-crm')).toEqual([]);
    });

    it('returns exactly the contract fields, with internal ones left out', async () => {
      await track('acme-crm');
      await insertSnapshot('acme-crm', {
        fetchedAt: new Date('2026-09-10T12:00:00.000Z'),
        price: '$29/mo',
        changed: true,
        summary: 'Price dropped.',
        summaryStatus: 'done',
        summaryProvider: 'deepseek',
        summaryModel: 'deepseek-chat',
      });

      const response = await request(baseUrl)
        .get('/api/competitors/acme-crm/snapshots')
        .expect(200);

      expect(response.body).toEqual([
        {
          fetchedAt: '2026-09-10T12:00:00.000Z',
          title: 'Acme',
          tagline: 'Fast',
          price: '$29/mo',
          description: 'Text',
          changed: true,
          summary: 'Price dropped.',
          summaryStatus: 'done',
          summaryProvider: 'deepseek',
          summaryModel: 'deepseek-chat',
        },
      ]);
    });

    it.each<[SummaryStatus, boolean]>([
      ['none', false],
      ['pending', true],
      ['failed', true],
    ])('returns a null summary when the status is %s', async (status, changed) => {
      await track('acme-crm');
      await insertSnapshot('acme-crm', {
        changed,
        summaryStatus: status,
        summaryError: status === 'failed' ? 'secret provider detail' : null,
      });

      const response = await request(baseUrl)
        .get('/api/competitors/acme-crm/snapshots')
        .expect(200);

      const [snapshot] = snapshotListSchema.parse(response.body);
      expect(snapshot?.summary).toBeNull();
      expect(snapshot?.summaryStatus).toBe(status);
      expect(snapshot?.changed).toBe(changed);
      expect(response.text).not.toContain('secret provider detail');
    });

    it('returns newest first, for that competitor only', async () => {
      await track('acme-crm', 'north-analytics');
      await insertSnapshot('acme-crm', { price: 'first' });
      await insertSnapshot('north-analytics', { price: 'other' });
      await insertSnapshot('acme-crm', { price: 'second' });
      await insertSnapshot('acme-crm', { price: 'third' });

      const rows = await getSnapshots('acme-crm');

      expect(rows.map((row) => row.price)).toEqual(['third', 'second', 'first']);
    });

    it('returns the newest rows up to ?limit=', async () => {
      await track('acme-crm');
      await insertSnapshot('acme-crm', { price: 'first' });
      await insertSnapshot('acme-crm', { price: 'second' });
      await insertSnapshot('acme-crm', { price: 'third' });

      const response = await request(baseUrl)
        .get('/api/competitors/acme-crm/snapshots?limit=2')
        .expect(200);

      expect(
        snapshotListSchema.parse(response.body).map((row) => row.price),
      ).toEqual(['third', 'second']);
    });

    it.each(['0', '-1', '1.5', 'abc', ''])(
      'returns 400 for ?limit=%s',
      async (limit) => {
        await track('acme-crm');

        await request(baseUrl)
          .get(`/api/competitors/acme-crm/snapshots?limit=${limit}`)
          .expect(400);
      },
    );

    it('shows a whole change: first snapshot, then a summarised change', async () => {
      await request(baseUrl)
        .post('/api/competitors')
        .send({ id: 'acme-crm' })
        .expect(201);
      await pollAll();
      await pollAll();

      const pending = await getSnapshots('acme-crm');
      expect(pending.map((row) => row.summaryStatus)).toEqual(['pending', 'none']);
      expect(pending.map((row) => row.summary)).toEqual([null, null]);

      await app.get(SummaryWorker, { strict: false }).check();

      const [newest, oldest] = await getSnapshots('acme-crm');
      expect(newest).toEqual(
        expect.objectContaining({
          price: '$39/mo',
          changed: true,
          summaryStatus: 'done',
          summaryProvider: 'mock',
          summaryModel: 'mock-llm',
        }),
      );
      expect(newest?.summary).toContain('Mock AI summary');
      expect(oldest).toEqual(
        expect.objectContaining({
          price: '$29/mo',
          changed: false,
          summary: null,
          summaryStatus: 'none',
        }),
      );
      expect(await mock.callCount()).toBe(1);
    });
  });

  describe('GET /healthz', () => {
    it('returns 200 when Postgres is reachable', async () => {
      const response = await request(baseUrl).get('/healthz').expect(200);

      expect(response.body).toEqual({ status: 'ok' });
    });
  });

  describe('logging', () => {
    it('logs adding and removing a competitor, but not a rejected add', async () => {
      const log = jest.spyOn(Logger.prototype, 'log');

      await request(baseUrl)
        .post('/api/competitors')
        .send({ id: 'does-not-exist' })
        .expect(422);
      expect(log).not.toHaveBeenCalledWith('Now tracking does-not-exist');

      await request(baseUrl)
        .post('/api/competitors')
        .send({ id: 'acme-crm' })
        .expect(201);
      await request(baseUrl).delete('/api/competitors/acme-crm').expect(204);

      expect(log).toHaveBeenCalledWith('Now tracking acme-crm');
      expect(log).toHaveBeenCalledWith('Stopped tracking acme-crm');
      log.mockRestore();
    });
  });
});
