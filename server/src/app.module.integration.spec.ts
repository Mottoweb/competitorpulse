import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { PROVIDER_NAMES } from './llm/providers';
import { Snapshot } from './poller/snapshot.entity';
import { MockLlm } from './testing/mock-llm';
import {
  createMigratedTestDatabase,
  dropTestDatabase,
  truncateAll,
} from './testing/test-database';

// Booting AppModule connects to Postgres, so this moved here from the unit suite.
describe('test setup', () => {
  let dataSource: DataSource;
  let mock: MockLlm;
  const originalDatabase = process.env.POSTGRES_DB;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    dataSource = await createMigratedTestDatabase('app_module');
    process.env.POSTGRES_DB = String(dataSource.options.database);
    mock = await MockLlm.start();
    // Tests never call a real provider, whatever keys the shell has set.
    PROVIDER_NAMES.forEach((name) => {
      delete process.env[`${name.toUpperCase()}_API_KEY`];
    });
    delete process.env.LLM_PROVIDER_ORDER;
    process.env.MOCK_API_KEY = 'test-key';
    process.env.MOCK_BASE_URL = mock.baseUrl;
  });

  afterAll(async () => {
    process.env.POSTGRES_DB = originalDatabase;
    delete process.env.MOCK_API_KEY;
    delete process.env.MOCK_BASE_URL;
    mock.stop();
    await dropTestDatabase(dataSource);
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs TypeScript and boots the Nest module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef.get(AppModule)).toBeInstanceOf(AppModule);

    await moduleRef.close();
  });

  it('polls due competitors at startup and finishes the check before closing', async () => {
    await dataSource.query(`INSERT INTO competitors (id) VALUES ('acme-crm')`);
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = moduleRef.createNestApplication();

    await app.init();
    await app.close();

    const rows = await dataSource.manager.find(Snapshot);
    expect(rows.map((row) => row.title)).toEqual(['Acme CRM']);
  });

  it('summarises pending snapshots at startup and finishes before closing', async () => {
    await dataSource.query(`INSERT INTO competitors (id, next_poll_at)
      VALUES ('acme', now() + interval '1 hour')`);
    await dataSource.query(
      `INSERT INTO snapshots (competitor_id, fetched_at, title, tagline, price,
         description, content_hash, changed, summary_status, summary_next_attempt_at)
       VALUES
         ('acme', now(), 'Acme', 'Fast', '$39', 'Text', 'a', false, 'none', NULL),
         ('acme', now(), 'Acme', 'Fast', '$29', 'Text', 'b', true, 'pending', now())`,
    );
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = moduleRef.createNestApplication();

    await app.init();
    await app.close();

    const row = await dataSource.manager.findOneBy(Snapshot, { changed: true });
    expect(row?.summaryStatus).toBe('done');
    expect(row?.summaryProvider).toBe('mock');
    expect(row?.summaryModel).toBe('mock-llm');
  });

  it('logs the provider order at startup', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.close();

    expect(log).toHaveBeenCalledWith('LLM provider order: mock');
  });
});
