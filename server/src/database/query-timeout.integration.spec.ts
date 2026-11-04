import { DataSource } from 'typeorm';
import { parseDatabaseConfig } from '../config';
import { createEmptyTestDatabase, dropTestDatabase } from '../testing/test-database';
import { buildDataSourceOptions } from './data-source-options';
import { isDatabaseUnavailable } from './database-unavailable';

describe('the query timeout', () => {
  let base: DataSource;
  let limited: DataSource;

  beforeAll(async () => {
    base = await createEmptyTestDatabase('query_timeout');
    limited = await new DataSource({
      ...buildDataSourceOptions(parseDatabaseConfig(process.env), {
        queryTimeoutMs: 100,
      }),
      database: String(base.options.database),
    }).initialize();
  });

  afterAll(async () => {
    await limited.destroy();
    await dropTestDatabase(base);
  });

  it('gives up on a query that takes too long, and counts as unavailable', async () => {
    const outcome: unknown = await limited
      .query('SELECT pg_sleep(1)')
      .then(() => 'answered', (error: unknown) => error);

    expect(outcome).not.toBe('answered');
    expect(isDatabaseUnavailable(outcome)).toBe(true);
  });
});
