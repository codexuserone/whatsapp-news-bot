import fs from 'fs/promises';
import path from 'path';
import * as dns from 'dns';
import dotenv from 'dotenv';
import { Client } from 'pg';

type ClientConfig = {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
  ssl: { rejectUnauthorized: boolean };
  connectionTimeoutMillis: number;
  keepAlive: boolean;
};

type ConnectionCandidate = {
  label: string;
  summary: string;
  config: ClientConfig;
};

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
    path.resolve(__dirname, '../../scripts/migrations'),
    path.resolve(__dirname, '../../../scripts'),
    path.resolve(__dirname, '../../../../scripts'),
    path.resolve(process.cwd(), 'scripts/migrations'),
    path.resolve(process.cwd(), 'scripts'),
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

const resolveClientConfig = async (databaseUrl: string) => {
  const parsed = new URL(databaseUrl);
  const host = parsed.hostname;
  let resolvedHost = host;

  try {
    const lookup = await dns.promises.lookup(host, { family: 4 });
    if (lookup?.address) {
      resolvedHost = lookup.address;
      process.stdout.write(`Resolved ${host} -> ${resolvedHost} (IPv4)\n`);
    }
  } catch {
    // Fall back to original host. NODE_OPTIONS/ipv4first still applies globally.
  }

  const database = parsed.pathname.replace(/^\//, '') || 'postgres';
  const port = Number(parsed.port || 5432);

  const config: any = {
    user: decodeURIComponent(parsed.username || ''),
    password: decodeURIComponent(parsed.password || ''),
    host: resolvedHost,
    port,
    database,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    keepAlive: true
  };

  return config;
};

const unique = (values: string[]) => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const next = String(value || '').trim();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    output.push(next);
  }
  return output;
};

const redactConnectionString = (value: string) => {
  try {
    const parsed = new URL(value);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return value;
  }
};

const extractSupabaseRef = (databaseUrl: string) => {
  try {
    const parsed = new URL(databaseUrl);
    const hostMatch = parsed.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
    if (hostMatch?.[1]) {
      return hostMatch[1].toLowerCase();
    }

    const userMatch = decodeURIComponent(parsed.username || '').match(/^postgres\.([a-z0-9]+)$/i);
    if (userMatch?.[1]) {
      return userMatch[1].toLowerCase();
    }
  } catch {
    // ignore
  }

  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  if (supabaseUrl) {
    try {
      const parsedSupabaseUrl = new URL(supabaseUrl);
      const ref = parsedSupabaseUrl.hostname.split('.')[0];
      if (ref) return ref.toLowerCase();
    } catch {
      // ignore
    }
  }

  return null;
};

const buildPoolerFallbackUrls = (databaseUrl: string) => {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return [] as Array<{ label: string; url: string }>;
  }

  const isDirectSupabaseHost = /^db\.[a-z0-9]+\.supabase\.co$/i.test(parsed.hostname);
  if (!isDirectSupabaseHost) {
    return [] as Array<{ label: string; url: string }>;
  }

  const ref = extractSupabaseRef(databaseUrl);
  if (!ref) {
    return [] as Array<{ label: string; url: string }>;
  }

  const poolerPort = Number(process.env.SUPABASE_POOLER_PORT || 6543);
  const explicitPoolerUrl = String(process.env.SUPABASE_POOLER_URL || '').trim();
  const explicitPoolerHost = String(process.env.SUPABASE_POOLER_HOST || '').trim();
  const explicitPoolerRegion = String(process.env.SUPABASE_POOLER_REGION || '').trim();

  const hostCandidates = unique([
    explicitPoolerHost,
    explicitPoolerRegion ? `aws-0-${explicitPoolerRegion}.pooler.supabase.com` : '',
    'aws-0-us-west-2.pooler.supabase.com',
    'aws-0-us-east-1.pooler.supabase.com',
    'aws-0-eu-west-1.pooler.supabase.com'
  ]);

  const userCandidates = unique([
    String(process.env.SUPABASE_POOLER_USER || ''),
    `postgres.${ref}`,
    decodeURIComponent(parsed.username || ''),
    'postgres'
  ]);

  const out: Array<{ label: string; url: string }> = [];
  if (explicitPoolerUrl) {
    out.push({
      label: 'SUPABASE_POOLER_URL',
      url: explicitPoolerUrl
    });
  }

  for (const host of hostCandidates) {
    for (const user of userCandidates) {
      try {
        const candidate = new URL(databaseUrl);
        candidate.hostname = host;
        candidate.port = String(poolerPort);
        candidate.username = user;
        if (!candidate.searchParams.get('sslmode')) {
          candidate.searchParams.set('sslmode', 'require');
        }
        out.push({
          label: `pooler ${host} as ${user}`,
          url: candidate.toString()
        });
      } catch {
        // ignore invalid candidate
      }
    }
  }

  const seen = new Set<string>();
  return out.filter((entry) => {
    if (!entry.url || seen.has(entry.url)) return false;
    seen.add(entry.url);
    return true;
  });
};

const buildConnectionCandidates = async (databaseUrl: string) => {
  const fallbacks = buildPoolerFallbackUrls(databaseUrl);
  const candidates: Array<{ label: string; url: string }> = [
    { label: 'primary', url: databaseUrl },
    ...fallbacks
  ];

  const output: ConnectionCandidate[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate.url || seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    const config = (await resolveClientConfig(candidate.url)) as ClientConfig;
    output.push({
      label: candidate.label,
      summary: redactConnectionString(candidate.url),
      config
    });
  }

  return output;
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

  const candidates = await buildConnectionCandidates(databaseUrl);
  let client: Client | null = null;
  let lastError: unknown = null;

  for (const candidate of candidates) {
    process.stdout.write(`Connecting with ${candidate.label}: ${candidate.summary}\n`);
    const attempt = new Client(candidate.config);
    try {
      await attempt.connect();
      client = attempt;
      process.stdout.write(`Connected using ${candidate.label}.\n`);
      break;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`Connection failed for ${candidate.label}: ${message}\n`);
      try {
        await attempt.end();
      } catch {
        // ignore
      }
    }
  }

  if (!client) {
    throw lastError instanceof Error ? lastError : new Error('Unable to connect to database for migrations');
  }

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

export { };
