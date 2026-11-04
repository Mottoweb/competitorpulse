import { buildDataSourceOptions } from './data-source-options';

const CONFIG = {
  host: 'localhost',
  port: 5432,
  username: 'user',
  password: 'password',
  database: 'database',
  logQueries: false,
};

describe('buildDataSourceOptions', () => {
  it('limits queries only when asked, so a long migration is never cut off', () => {
    expect(buildDataSourceOptions(CONFIG).extra).toBeUndefined();
    expect(
      buildDataSourceOptions(CONFIG, { queryTimeoutMs: 10_000 }).extra,
    ).toEqual({ query_timeout: 10_000 });
  });

  it('limits how long a new connection can wait', () => {
    const options = buildDataSourceOptions({
      host: 'localhost',
      port: 5432,
      username: 'user',
      password: 'password',
      database: 'database',
      logQueries: false,
    });

    expect(options.connectTimeoutMS).toBeGreaterThan(0);
  });
});
