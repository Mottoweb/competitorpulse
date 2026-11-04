import 'reflect-metadata';
import { Logger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { PROVIDER_NAMES } from '../llm/providers';
import { MockLlm } from '../testing/mock-llm';
import {
  createMigratedTestDatabase,
  dropTestDatabase,
} from '../testing/test-database';

const INDEX_HTML = '<!doctype html><title>CompetitorPulse test page</title>';

describe('serving the web app', () => {
  let dataSource: DataSource;
  let mock: MockLlm;
  let app: INestApplication;
  let baseUrl: string;
  let webRoot: string;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    Logger.overrideLogger(false);
    dataSource = await createMigratedTestDatabase('web_static');
    mock = await MockLlm.start();
    // CI doesn't build the web app before these tests, so they serve a stand-in.
    webRoot = mkdtempSync(join(tmpdir(), 'competitor-pulse-web-'));
    writeFileSync(join(webRoot, 'index.html'), INDEX_HTML);
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log("app");');
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

    // As main.ts boots it. Under Test.createTestingModule, serve-static sees no
    // HTTP adapter at compile time and silently serves nothing.
    app = await NestFactory.create(AppModule, { logger: false });
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

  it('serves the app at the root', async () => {
    const response = await request(baseUrl).get('/').expect(200);

    expect(response.type).toBe('text/html');
    expect(response.text).toBe(INDEX_HTML);
  });

  it('serves the app for a deep link, so a timeline URL survives a reload', async () => {
    const response = await request(baseUrl)
      .get('/competitors/acme-crm')
      .expect(200);

    expect(response.type).toBe('text/html');
    expect(response.text).toBe(INDEX_HTML);
  });

  it('serves built assets', async () => {
    const response = await request(baseUrl).get('/assets/app.js').expect(200);

    expect(response.type).toMatch(/javascript/);
  });

  it('leaves the API to its controllers', async () => {
    const response = await request(baseUrl).get('/api/competitors').expect(200);

    expect(response.type).toBe('application/json');
    expect(response.body).toEqual([]);
  });

  it('answers an unknown API path with a JSON 404, not the app', async () => {
    const response = await request(baseUrl).get('/api/nope').expect(404);

    expect(response.type).toBe('application/json');
  });

  it('answers the bare API prefix with a JSON 404, not the app', async () => {
    const response = await request(baseUrl).get('/api').expect(404);

    expect(response.type).toBe('application/json');
  });

  it('leaves the health check to its controller', async () => {
    const response = await request(baseUrl).get('/healthz').expect(200);

    expect(response.type).toBe('application/json');
    expect(response.body).toEqual({ status: 'ok' });
  });
});
