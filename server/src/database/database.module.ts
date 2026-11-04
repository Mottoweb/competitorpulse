import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { parseDatabaseConfig } from '../config';
import { buildDataSourceOptions } from './data-source-options';
import { DatabaseUnavailableFilter } from './database-unavailable.filter';

// A host that freezes keeps its connections open and never answers, which would
// otherwise stall the workers and leave abandoned health checks holding the pool.
const QUERY_TIMEOUT_MS = 10_000;

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () =>
        buildDataSourceOptions(parseDatabaseConfig(process.env), {
          queryTimeoutMs: QUERY_TIMEOUT_MS,
        }),
    }),
  ],
  providers: [{ provide: APP_FILTER, useClass: DatabaseUnavailableFilter }],
})
export class DatabaseModule {}
