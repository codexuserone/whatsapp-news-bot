import path from 'path';
import { promises as fs } from 'fs';
import { createRequire } from 'module';

const requireFromServer = createRequire(path.resolve('server/package.json'));
const { Client } = requireFromServer('pg');
const dotenv = requireFromServer('dotenv');

dotenv.config({ path: path.resolve('server/.env') });

const listSqlFiles = async (dirPath) => {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
};

const main = async () => {
  const migrationsDir = path.resolve('server/scripts/migrations');
  const files = await listSqlFiles(migrationsDir);
  if (!files.length) {
    throw new Error(`No SQL migration files found in ${migrationsDir}`);
  }

  const databaseUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL or SUPABASE_DB_URL is required to check migration status.');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set((rows || []).map((row) => String(row.filename || '')));
    const pending = files.filter((file) => !applied.has(file));

    console.log(`Total migrations: ${files.length}`);
    console.log(`Applied migrations: ${files.length - pending.length}`);
    console.log(`Pending migrations: ${pending.length}`);

    if (pending.length) {
      console.error('Pending migration files:');
      for (const file of pending) {
        console.error(`- ${file}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log('All migrations are applied.');
  } finally {
    await client.end();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
