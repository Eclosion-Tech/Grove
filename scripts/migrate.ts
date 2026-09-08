import { createPostgresDatabase, migrate } from '@eclosion-tech/grove/server';
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL');
const db = createPostgresDatabase(process.env.DATABASE_URL);
try { await migrate(db); console.log('Grove migrations applied.'); }
finally { await db.close(); }
