import type { DataSource } from 'typeorm';
import {
  createEmptyTestDatabase,
  dropTestDatabase,
} from '../testing/test-database';

interface NameRow {
  name: string;
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
}

interface IndexRow {
  indexname: string;
  indexdef: string;
}

const APP_TABLES = ['competitors', 'snapshots', 'source_cursors'];

async function appTables(dataSource: DataSource): Promise<string[]> {
  const rows = await dataSource.query<NameRow[]>(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name <> 'migrations'
     ORDER BY table_name`,
  );
  return rows.map((row) => row.name);
}

describe('migrations', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await createEmptyTestDatabase('migrations');
  });

  afterAll(async () => {
    await dropTestDatabase(dataSource);
  });

  describe('after applying to an empty database', () => {
    beforeAll(async () => {
      await dataSource.runMigrations();
    });

    it('creates the three tables', async () => {
      expect(await appTables(dataSource)).toEqual(APP_TABLES);
    });

    it('reports no drift between entities and migrations', async () => {
      // Same check as `typeorm migration:generate --check`.
      const plan = await dataSource.driver.createSchemaBuilder().log();
      expect(plan.upQueries.map((query) => query.query)).toEqual([]);
    });

    it('creates the planned columns', async () => {
      const rows = await dataSource.query<ColumnRow[]>(
        `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name <> 'migrations'
         ORDER BY table_name, column_name`,
      );
      const summary = rows.map(
        (row) =>
          `${row.table_name}.${row.column_name} ${row.data_type} ${row.is_nullable}`,
      );

      expect(summary).toEqual([
        'competitors.created_at timestamp with time zone NO',
        'competitors.id text NO',
        'competitors.next_poll_at timestamp with time zone NO',
        'snapshots.changed boolean NO',
        'snapshots.competitor_id text NO',
        'snapshots.content_hash text NO',
        'snapshots.description text NO',
        'snapshots.fetched_at timestamp with time zone NO',
        'snapshots.id bigint NO',
        'snapshots.price text NO',
        'snapshots.summary text YES',
        'snapshots.summary_attempts integer NO',
        'snapshots.summary_error text YES',
        'snapshots.summary_model text YES',
        'snapshots.summary_next_attempt_at timestamp with time zone YES',
        'snapshots.summary_provider text YES',
        'snapshots.summary_status USER-DEFINED NO',
        'snapshots.tagline text NO',
        'snapshots.title text NO',
        'source_cursors.competitor_id text NO',
        'source_cursors.position integer NO',
      ]);
    });

    it('creates the indexes the claim and timeline queries need', async () => {
      const rows = await dataSource.query<IndexRow[]>(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname IN (
             'competitors_next_poll_at_idx',
             'snapshots_competitor_id_id_idx',
             'snapshots_summary_due_idx'
           )
         ORDER BY indexname`,
      );
      const definitions = new Map(
        rows.map((row) => [row.indexname, row.indexdef]),
      );

      expect(definitions.get('competitors_next_poll_at_idx')).toContain(
        '(next_poll_at)',
      );
      expect(definitions.get('snapshots_competitor_id_id_idx')).toContain(
        '(competitor_id, id)',
      );
      const summaryDue = definitions.get('snapshots_summary_due_idx');
      expect(summaryDue).toContain('(summary_next_attempt_at)');
      expect(summaryDue).toContain("WHERE (summary_status = 'pending'");
    });

    it('rejects a summary status outside the closed set', async () => {
      await dataSource.query(
        `INSERT INTO competitors (id) VALUES ('status-check')`,
      );
      await expect(
        dataSource.query(
          `INSERT INTO snapshots (competitor_id, fetched_at, title, tagline, price,
             description, content_hash, changed, summary_status)
           VALUES ('status-check', now(), 't', 't', 'p', 'd', 'h', false, 'unknown')`,
        ),
      ).rejects.toThrow(/invalid input value for enum/);
      await dataSource.query(`DELETE FROM competitors`);
    });

    it('makes a new competitor due immediately', async () => {
      await dataSource.query(`INSERT INTO competitors (id) VALUES ('due-check')`);
      const rows = await dataSource.query<NameRow[]>(
        `SELECT id AS name FROM competitors WHERE next_poll_at <= now()`,
      );
      expect(rows).toEqual([{ name: 'due-check' }]);
      await dataSource.query(`DELETE FROM competitors`);
    });

    it('cascades a competitor delete to its snapshots and cursor', async () => {
      await dataSource.query(
        `INSERT INTO competitors (id) VALUES ('cascade-check'), ('kept')`,
      );
      await dataSource.query(
        `INSERT INTO snapshots (competitor_id, fetched_at, title, tagline, price,
           description, content_hash, changed)
         VALUES ('cascade-check', now(), 't', 't', 'p', 'd', 'h', false),
                ('kept', now(), 't', 't', 'p', 'd', 'h', false)`,
      );
      await dataSource.query(
        `INSERT INTO source_cursors (competitor_id, position)
         VALUES ('cascade-check', 2), ('kept', 1)`,
      );

      await dataSource.query(
        `DELETE FROM competitors WHERE id = 'cascade-check'`,
      );

      expect(
        await dataSource.query<NameRow[]>(
          `SELECT competitor_id AS name FROM snapshots`,
        ),
      ).toEqual([{ name: 'kept' }]);
      expect(
        await dataSource.query<NameRow[]>(
          `SELECT competitor_id AS name FROM source_cursors`,
        ),
      ).toEqual([{ name: 'kept' }]);
      await dataSource.query(`DELETE FROM competitors`);
    });
  });

  describe('after rolling every migration back', () => {
    it('removes the tables and the enum type', async () => {
      const applied = dataSource.migrations.length;
      expect(applied).toBeGreaterThan(0);

      await dataSource.runMigrations();
      for (let undone = 0; undone < applied; undone += 1) {
        // Migrations must be undone one at a time, newest first.
        await dataSource.undoLastMigration();
      }

      expect(await appTables(dataSource)).toEqual([]);
      const enumTypes = await dataSource.query<NameRow[]>(
        `SELECT typname AS name FROM pg_type WHERE typname = 'summary_status'`,
      );
      expect(enumTypes).toEqual([]);
    });
  });
});
