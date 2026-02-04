import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { Client } from 'pg';

const loadEnv = () => {
  // server/.env
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
  // repo root .env (optional)
  dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
};

const getMigrationsDir = () => path.resolve(__dirname, '../../../scripts');

const listSqlFiles = async (dir: string) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.sql'))
    .map((e) => e.name);

  const score = (name: string) => {
    const match = name.match(/^(\d+)_/);
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
  };

  return files.sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) return sa - sb;
    return a.localeCompare(b);
  });
};

const runMigrations = async () => {
  loadEnv();

  const databaseUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!databaseUrl) {
    throw new Error(
      'Missing DATABASE_URL. Add it to server/.env (Postgres connection string) before running migrations.'
    );
  }

  const migrationsDir = getMigrationsDir();
  const files = await listSqlFiles(migrationsDir);
  if (!files.length) {
    throw new Error(`No .sql files found in ${migrationsDir}`);
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    const { rows: appliedRows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set((appliedRows || []).map((r: { filename?: string }) => String(r.filename || '')));

    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }
      const fullPath = path.join(migrationsDir, file);
      const sql = await fs.readFile(fullPath, 'utf8');
      if (!sql.trim()) continue;

      process.stdout.write(`Applying ${file}... `);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING', [
          file
        ]);
        await client.query('COMMIT');
        process.stdout.write('OK\n');
      } catch (err) {
        await client.query('ROLLBACK');
        process.stdout.write('FAILED\n');
        throw err;
      }
    }
  } finally {
    await client.end();
  }
};

if (require.main === module) {
  runMigrations().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}

module.exports = {
  runMigrations
};

export {};
