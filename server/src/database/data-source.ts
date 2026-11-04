import 'reflect-metadata';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { loadEnvFile, parseDatabaseConfig } from '../config';
import { buildDataSourceOptions } from './data-source-options';

// The repo root's .env, the same file docker compose reads. Integration tests
// never import this file, so a dev .env can't redirect them to a dev database.
loadEnvFile(join(__dirname, '../../../.env'), process.env);

// Entry point for the TypeORM CLI, which needs one exported DataSource.
export default new DataSource(
  buildDataSourceOptions(parseDatabaseConfig(process.env)),
);
