import { join } from 'node:path';
import type { PostgresDataSourceOptions } from 'typeorm/driver/postgres/PostgresDataSourceOptions';
import { Competitor } from '../competitors/competitor.entity';
import type { DatabaseConfig } from '../config';
import { Snapshot } from '../poller/snapshot.entity';
import { SourceCursor } from '../source/source-cursor.entity';

export interface DataSourceLimits {
  /** Gives up on a query with no answer. Left out for migrations, which can take long. */
  queryTimeoutMs?: number;
}

export function buildDataSourceOptions(
  config: DatabaseConfig,
  limits: DataSourceLimits = {},
): PostgresDataSourceOptions {
  return {
    type: 'postgres',
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    entities: [Competitor, Snapshot, SourceCursor],
    // src/database and dist/src/database both sit two levels below the folder
    // that holds migrations/.
    migrations: [join(__dirname, '../../migrations/*.{ts,js}')],
    synchronize: false,
    // Without this a host that never answers leaves callers waiting indefinitely.
    connectTimeoutMS: 5_000,
    ...(limits.queryTimeoutMs === undefined
      ? {}
      : { extra: { query_timeout: limits.queryTimeoutMs } }),
    logging: config.logQueries,
  };
}
