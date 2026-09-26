import postgres from 'postgres';
import { readFile } from 'node:fs/promises';

export type Row = Record<string, any>;
export interface Queryable {
  query<T extends Row = Row>(sql: string, values?: unknown[]): Promise<T[]>;
}
export interface Database extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function createPostgresDatabase(url: string): Database {
  // Postgres.js does not interpret libpq's ?host=/socket/directory convention itself.
  const parsed = new URL(url);
  const host = parsed.searchParams.get('host');
  parsed.searchParams.delete('host');
  const connection = postgres(parsed.toString(), { max: 10, onnotice: () => {}, ...(host ? { host } : {}) });
  function wrap(sql: postgres.Sql | postgres.TransactionSql): Queryable {
    return { query: async <T extends Row>(query: string, values: unknown[] = []) =>
      Array.from(await sql.unsafe(query, values as postgres.ParameterOrJSON<never>[])) as T[] };
  }
  return {
    ...wrap(connection),
    transaction: async <T>(work: (tx: Queryable) => Promise<T>) =>
      connection.begin(async tx => work(wrap(tx))) as Promise<T>,
    close: () => connection.end(),
  };
}

/** Explicit, transactional migration; never run implicitly on an HTTP request. */
export async function migrate(db: Database): Promise<void> {
  await db.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(718301, 1)");
    await tx.query('CREATE TABLE IF NOT EXISTS grove_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const [index, filename] of ['001_initial.sql', '002_relationships_media.sql', '003_admin_actions.sql', '004_members_sessions.sql', '005_accounts.sql'].entries()) {
      const version = index + 1;
      if ((await tx.query('SELECT version FROM grove_migrations WHERE version = $1', [version])).length) continue;
      const sql = await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8');
      // These migrations contain no procedural functions or semicolons inside literals.
      for (const statement of sql.split(';').filter(s => s.trim())) await tx.query(statement);
      await tx.query('INSERT INTO grove_migrations (version) VALUES ($1)', [version]);
    }
  });
}
