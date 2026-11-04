import 'reflect-metadata';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { specViolations } from '../testing/openapi-contract';
import { HEALTH_QUERY_TIMEOUT_MS, HealthController } from './health.controller';

describe('GET /healthz with Postgres unreachable', () => {
  let app: INestApplication;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: DataSource,
          useValue: {
            query: () => Promise.reject(new Error('connect ECONNREFUSED')),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 503 and does not leak the error', async () => {
    const response = await request(await app.getUrl())
      .get('/healthz')
      .expect(503);

    expect(response.body).toEqual({ status: 'unavailable' });
    expect(response.text).not.toContain('ECONNREFUSED');
  });

  it('matches the committed OpenAPI spec', async () => {
    const response = await request(await app.getUrl())
      .get('/healthz')
      .expect(503);

    expect(specViolations('get', '/healthz', response)).toEqual([]);
  });
});

describe('GET /healthz with Postgres not answering', () => {
  let app: INestApplication;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: DataSource,
          useValue: { query: () => new Promise(() => undefined) },
        },
        { provide: HEALTH_QUERY_TIMEOUT_MS, useValue: 20 },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 503 rather than hanging', async () => {
    const response = await request(await app.getUrl())
      .get('/healthz')
      .timeout(1_000)
      .expect(503);

    expect(response.body).toEqual({ status: 'unavailable' });
  });
});
