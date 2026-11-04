import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { parseDatabaseConfig } from '../config';
import { buildDataSourceOptions } from '../database/data-source-options';

function testDatabaseOptions(database: string) {
  return {
    ...buildDataSourceOptions(parseDatabaseConfig(process.env)),
    database,
    logging: false,
  };
}

async function withAdminConnection(
  run: (admin: DataSource) => Promise<void>,
): Promise<void> {
  const admin = await new DataSource(testDatabaseOptions('postgres')).initialize();
  try {
    await run(admin);
  } finally {
    await admin.destroy();
  }
}

/**
 * Creates an empty database that only one spec file uses. Spec files can then
 * run in parallel, and truncating tables can never touch development data.
 * Migrations are left to the caller.
 */
export async function createEmptyTestDatabase(
  name: string,
): Promise<DataSource> {
  if (!/^[a-z_]+$/.test(name)) {
    throw new Error(`Invalid test database name: ${name}`);
  }
  const database = `competitor_pulse_test_${name}`;
  await withAdminConnection(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${database}`);
  });
  return new DataSource(testDatabaseOptions(database)).initialize();
}

export async function createMigratedTestDatabase(
  name: string,
): Promise<DataSource> {
  const dataSource = await createEmptyTestDatabase(name);
  await dataSource.runMigrations();
  return dataSource;
}

export async function dropTestDatabase(dataSource: DataSource): Promise<void> {
  const database = String(dataSource.options.database);
  await dataSource.destroy();
  await withAdminConnection(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  });
}

export async function truncateAll(dataSource: DataSource): Promise<void> {
  await dataSource.query('TRUNCATE competitors CASCADE');
}
