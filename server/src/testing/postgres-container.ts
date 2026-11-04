import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

declare global {
  // Jest's global setup and teardown share only the process and its globals.
  var __postgresContainer: StartedPostgreSqlContainer | undefined;
}
