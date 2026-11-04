import 'reflect-metadata';
import { Logger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { Competitor } from '../competitors/competitor.entity';
import type { SummaryStatus } from '../competitors/contract';
import { PROVIDER_NAMES } from '../llm/providers';
import { Snapshot } from '../poller/snapshot.entity';
import { MockLlm } from '../testing/mock-llm';
import {
  readCommittedSpec,
  specViolations,
} from '../testing/openapi-contract';
import {
  createMigratedTestDatabase,
  dropTestDatabase,
  truncateAll,
} from '../testing/test-database';
import { setupSwagger } from './openapi';

const COMPETITORS = '/api/competitors';
const COMPETITOR = '/api/competitors/{id}';
const SNAPSHOTS = '/api/competitors/{id}/snapshots';

describe('real responses against the committed OpenAPI spec', () => {
  let dataSource: DataSource;
  let mock: MockLlm;
  let app: INestApplication;
  let baseUrl: string;
  let webRoot: string;
  const originalEnv = { ...process.env };

  async function insertSnapshot(
    summaryStatus: SummaryStatus,
    summary: string | null,
  ): Promise<void> {
    await dataSource.manager.insert(Snapshot, {
      competitorId: 'acme-crm',
      fetchedAt: new Date('2026-09-10T12:00:00.000Z'),
      title: 'Acme',
      tagline: 'Fast',
      price: '$29',
      description: 'Text',
      contentHash: 'hash',
      changed: summaryStatus !== 'none',
      summaryStatus,
      summary,
      summaryProvider: summaryStatus === 'done' ? 'mock' : null,
      summaryModel: summaryStatus === 'done' ? 'mock-llm' : null,
    });
  }

  beforeAll(async () => {
    Logger.overrideLogger(false);
    dataSource = await createMigratedTestDatabase('openapi_contract');
    mock = await MockLlm.start();
    webRoot = mkdtempSync(join(tmpdir(), 'competitor-pulse-web-'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>App</title>');
    // Tests never call a real provider, whatever keys the shell has set.
    PROVIDER_NAMES.forEach((name) => {
      delete process.env[`${name.toUpperCase()}_API_KEY`];
    });
    delete process.env.LLM_PROVIDER_ORDER;
    Object.assign(process.env, {
      MOCK_API_KEY: 'test-key',
      MOCK_BASE_URL: mock.baseUrl,
      CHECK_INTERVAL_SECONDS: '3600',
      POSTGRES_DB: String(dataSource.options.database),
      WEB_DIST_DIR: webRoot,
    });

    // As main.ts boots it, with static serving active.
    app = await NestFactory.create(AppModule, { logger: false });
    setupSwagger(app);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
    mock.stop();
    await dropTestDatabase(dataSource);
    rmSync(webRoot, { recursive: true, force: true });
    process.env = originalEnv;
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
  });

  describe('GET /api/competitors', () => {
    it('matches when empty and when listing', async () => {
      const empty = await request(baseUrl).get(COMPETITORS).expect(200);
      expect(specViolations('get', COMPETITORS, empty)).toEqual([]);

      await dataSource.manager.insert(Competitor, { id: 'acme-crm' });
      const listed = await request(baseUrl).get(COMPETITORS).expect(200);
      expect(specViolations('get', COMPETITORS, listed)).toEqual([]);
    });
  });

  describe('POST /api/competitors', () => {
    it('matches on 201 and on 409', async () => {
      const created = await request(baseUrl)
        .post(COMPETITORS)
        .send({ id: 'acme-crm' })
        .expect(201);
      expect(specViolations('post', COMPETITORS, created)).toEqual([]);

      const conflict = await request(baseUrl)
        .post(COMPETITORS)
        .send({ id: 'acme-crm' })
        .expect(409);
      expect(specViolations('post', COMPETITORS, conflict)).toEqual([]);
    });

    it('matches on 400 for an invalid id', async () => {
      const response = await request(baseUrl)
        .post(COMPETITORS)
        .send({ id: 'Not Valid' })
        .expect(400);

      expect(specViolations('post', COMPETITORS, response)).toEqual([]);
    });

    it('matches on 400 for malformed JSON', async () => {
      const response = await request(baseUrl)
        .post(COMPETITORS)
        .set('Content-Type', 'application/json')
        .send('{"id":')
        .expect(400);

      expect(specViolations('post', COMPETITORS, response)).toEqual([]);
    });

    it('matches on 422 for an id the source does not know', async () => {
      const response = await request(baseUrl)
        .post(COMPETITORS)
        .send({ id: 'not-a-real-one' })
        .expect(422);

      expect(specViolations('post', COMPETITORS, response)).toEqual([]);
    });
  });

  describe('DELETE /api/competitors/{id}', () => {
    it('matches on 204 and on 404', async () => {
      await dataSource.manager.insert(Competitor, { id: 'acme-crm' });

      const removed = await request(baseUrl)
        .delete(`${COMPETITORS}/acme-crm`)
        .expect(204);
      expect(specViolations('delete', COMPETITOR, removed)).toEqual([]);

      const missing = await request(baseUrl)
        .delete(`${COMPETITORS}/acme-crm`)
        .expect(404);
      expect(specViolations('delete', COMPETITOR, missing)).toEqual([]);
    });
  });

  describe('GET /api/competitors/{id}/snapshots', () => {
    it('matches with a snapshot in each summary state', async () => {
      await dataSource.manager.insert(Competitor, { id: 'acme-crm' });
      await insertSnapshot('none', null);
      await insertSnapshot('pending', null);
      await insertSnapshot('failed', null);
      await insertSnapshot('done', 'Price dropped.');

      const response = await request(baseUrl)
        .get(`${COMPETITORS}/acme-crm/snapshots`)
        .expect(200);

      expect(response.body).toHaveLength(4);
      expect(specViolations('get', SNAPSHOTS, response)).toEqual([]);
    });

    it('matches on 400 for a bad limit and on 404 for an untracked id', async () => {
      await dataSource.manager.insert(Competitor, { id: 'acme-crm' });

      const badLimit = await request(baseUrl)
        .get(`${COMPETITORS}/acme-crm/snapshots?limit=0`)
        .expect(400);
      expect(specViolations('get', SNAPSHOTS, badLimit)).toEqual([]);

      const missing = await request(baseUrl)
        .get(`${COMPETITORS}/untracked/snapshots`)
        .expect(404);
      expect(specViolations('get', SNAPSHOTS, missing)).toEqual([]);
    });
  });

  describe('GET /healthz', () => {
    it('matches on 200', async () => {
      const response = await request(baseUrl).get('/healthz').expect(200);

      expect(specViolations('get', '/healthz', response)).toEqual([]);
    });
  });

  describe('Swagger UI', () => {
    it('serves the page and every script and stylesheet it references', async () => {
      const page = await fetch(`${baseUrl}/api/docs`);
      const html = await page.text();

      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(html).toContain('swagger-ui');

      const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(
        (match) => new URL(match[1] ?? '', page.url).href,
      );
      expect(assets.length).toBeGreaterThan(0);
      const responses = await Promise.all(assets.map((asset) => fetch(asset)));
      // An unread response holds its connection open, which stalls app.close().
      await Promise.all(responses.map((response) => response.arrayBuffer()));
      expect(
        responses
          .filter((response) => response.status !== 200)
          .map((response) => response.url),
      ).toEqual([]);
    });

    it('serves the same document that is committed', async () => {
      const response = await request(baseUrl).get('/api/docs-json').expect(200);

      expect(response.body).toEqual(readCommittedSpec());
    });

    it('leaves the bare API prefix as a JSON 404', async () => {
      const response = await request(baseUrl).get('/api').expect(404);

      expect(response.type).toBe('application/json');
    });
  });
});
