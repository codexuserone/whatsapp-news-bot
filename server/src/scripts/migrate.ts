import fs from 'fs/promises';
import path from 'path';
import * as dns from 'dns';
import dotenv from 'dotenv';
import { Client } from 'pg';

const preferIpv4 = () => {
  try {
    const setter = (dns as unknown as { setDefaultResultOrder?: (order: string) => void }).setDefaultResultOrder;
    if (typeof setter === 'function') {
      setter('ipv4first');
    }
  } catch {
    // ignore
  }
};

const loadEnv = () => {
  // server/.env
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
  // repo root .env (optional)
  dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
};

const dirExists = async (value: string) => {
  try {
    const stat = await fs.stat(value);
    return stat.isDirectory();
  } catch {
    return false;
  }
};

const resolveMigrationsDir = async () => {
  const candidates = [
    path.resolve(__dirname, '../../../scripts'),
    path.resolve(__dirname, '../../../../scripts'),
    path.resolve(process.cwd(), 'scripts'),
    path.resolve(process.cwd(), '../scripts'),
    path.resolve(process.cwd(), '../../scripts')
  ];

  for (const candidate of candidates) {
    if (!(await dirExists(candidate))) continue;
    try {
      const files = await listSqlFiles(candidate);
      if (files.length) return { dir: candidate, files };
    } catch {
      continue;
    }
  }

  for (const candidate of candidates) {
    if (await dirExists(candidate)) {
      return { dir: candidate, files: [] as string[] };
    }
  }

  return { dir: candidates[0] || path.resolve(__dirname, '../../../scripts'), files: [] as string[] };
};

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
  preferIpv4();
  loadEnv();

  // Prefer SUPABASE_DB_URL (typically a pooler/IPv4-friendly endpoint) when available.
  const databaseUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  const databaseUrlSource = process.env.SUPABASE_DB_URL
    ? 'SUPABASE_DB_URL'
    : process.env.DATABASE_URL
      ? 'DATABASE_URL'
      : null;
  if (!databaseUrl) {
    throw new Error(
      'Missing DATABASE_URL (or SUPABASE_DB_URL). Add a Postgres connection string to server/.env (local) or Render env vars (prod) before running migrations.'
    );
  }

  const resolved = await resolveMigrationsDir();
  const migrationsDir = resolved.dir;
  process.stdout.write(`Using ${databaseUrlSource || 'DATABASE_URL'} for migrations.\n`);
  process.stdout.write(`Scanning migrations in ${migrationsDir}\n`);
  const files = resolved.files.length ? resolved.files : await listSqlFiles(migrationsDir);
  if (!files.length) {
    throw new Error(`No .sql files found in ${migrationsDir}`);
  }

  const clientConfig: any = {
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    // Render frequently has IPv4-only egress. Avoid AAAA-first connection attempts.
    family: 4,
    connectionTimeoutMillis: 15000,
    keepAlive: true
  };

  const client = new Client(clientConfig);

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

    try {
      await client.query("NOTIFY pgrst, 'reload schema';");
      process.stdout.write('Requested PostgREST schema reload.\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`Failed to notify PostgREST schema reload: ${message}\n`);
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
