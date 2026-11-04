import { PostgreSqlContainer } from '@testcontainers/postgresql';
import './postgres-container';

/**
 * Starts a throwaway Postgres on a random port and points the database config
 * at it. Jest workers inherit this environment. If the run crashes,
 * Testcontainers' reaper removes the container.
 */
export default async function setup(): Promise<void> {
  // Each DROP DATABASE forces a checkpoint, and spec files run in parallel, so
  // drops queue behind each other past Jest's hook timeout. This data is
  // thrown away, so it doesn't need fsync's protection against a power cut.
  const container = await new PostgreSqlContainer('postgres:16')
    .withCommand(['postgres', '-c', 'fsync=off'])
    .start();
  globalThis.__postgresContainer = container;

  process.env.POSTGRES_HOST = container.getHost();
  process.env.POSTGRES_PORT = String(container.getPort());
  process.env.POSTGRES_USER = container.getUsername();
  process.env.POSTGRES_PASSWORD = container.getPassword();
  process.env.POSTGRES_DB = container.getDatabase();
}
