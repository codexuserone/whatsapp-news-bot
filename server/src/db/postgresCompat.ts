import type { Pool as PgPool } from 'pg';

const dns = require('dns');
const { Pool } = require('pg');
const { getErrorMessage } = require('../utils/errorUtils');

type RelationDefinition = {
  table: string;
  localColumn: string;
  remoteColumn: string;
};

type RelationSelect = {
  alias: string;
  table: string;
  fields: string[];
};

type SelectSpec = {
  baseAll: boolean;
  baseFields: string[];
  relations: RelationSelect[];
};

type OrderSpec = {
  field: string;
  ascending: boolean;
  nullsFirst?: boolean;
};

type QueryResponse<T = any> = {
  data: T;
  error: Record<string, unknown> | null;
  count?: number | null;
};

type MutationKind = 'select' | 'insert' | 'update' | 'delete' | 'upsert';

type OrParseResult = {
  sql: string;
  params: unknown[];
};

const RELATION_DEFINITIONS: Record<string, Record<string, RelationDefinition>> = {
  feed_items: {
    feed: { table: 'feeds', localColumn: 'feed_id', remoteColumn: 'id' },
    feeds: { table: 'feeds', localColumn: 'feed_id', remoteColumn: 'id' }
  },
  message_logs: {
    schedule: { table: 'schedules', localColumn: 'schedule_id', remoteColumn: 'id' },
    schedules: { table: 'schedules', localColumn: 'schedule_id', remoteColumn: 'id' },
    feed_item: { table: 'feed_items', localColumn: 'feed_item_id', remoteColumn: 'id' },
    feed_items: { table: 'feed_items', localColumn: 'feed_item_id', remoteColumn: 'id' },
    target: { table: 'targets', localColumn: 'target_id', remoteColumn: 'id' },
    targets: { table: 'targets', localColumn: 'target_id', remoteColumn: 'id' },
    template: { table: 'templates', localColumn: 'template_id', remoteColumn: 'id' },
    templates: { table: 'templates', localColumn: 'template_id', remoteColumn: 'id' }
  },
  schedules: {
    feed: { table: 'feeds', localColumn: 'feed_id', remoteColumn: 'id' },
    feeds: { table: 'feeds', localColumn: 'feed_id', remoteColumn: 'id' },
    template: { table: 'templates', localColumn: 'template_id', remoteColumn: 'id' },
    templates: { table: 'templates', localColumn: 'template_id', remoteColumn: 'id' }
  }
};

const JSON_ARRAY_COLUMNS: Record<string, Set<string>> = {
  templates: new Set(['sequence_steps'])
};

let pgPool: PgPool | null | undefined;
let pgPoolErrorHandlerBound = false;
let pgCircuitOpenUntil = 0;
let pgLastFailureAt = 0;
let pgLastFailureMessage: string | null = null;

const POSTGRES_CIRCUIT_BREAKER_MS = Math.max(
  5000,
  Math.floor(Number(process.env.POSTGRES_CIRCUIT_BREAKER_MS || process.env.SUPABASE_CIRCUIT_BREAKER_MS || 45_000))
);
const POSTGRES_QUERY_RETRIES = Math.max(
  0,
  Math.floor(Number(process.env.POSTGRES_QUERY_RETRIES || 6))
);
const POSTGRES_QUERY_RETRY_BASE_MS = Math.max(
  0,
  Math.floor(Number(process.env.POSTGRES_QUERY_RETRY_BASE_MS || 500))
);
const POSTGRES_QUERY_RETRY_MAX_MS = Math.max(
  POSTGRES_QUERY_RETRY_BASE_MS,
  Math.floor(Number(process.env.POSTGRES_QUERY_RETRY_MAX_MS || 5000))
);
const POSTGRES_POOL_MAX = Math.max(
  1,
  Math.floor(Number(process.env.POSTGRES_POOL_MAX || process.env.POSTGRES_MAX_POOL || 2))
);

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

const resolvePostgresConnectionString = () => {
  const provider = String(process.env.DB_PROVIDER || '').trim().toLowerCase();
  const candidates =
    provider === 'neon'
      ? [
          process.env.NEON_DATABASE_URL,
          process.env.POSTGRES_URL,
          process.env.DATABASE_URL,
          process.env.SUPABASE_POOLER_URL,
          process.env.SUPABASE_DB_URL
        ]
      : provider === 'postgres'
        ? [
            process.env.POSTGRES_URL,
            process.env.DATABASE_URL,
            process.env.NEON_DATABASE_URL,
            process.env.SUPABASE_POOLER_URL,
            process.env.SUPABASE_DB_URL
          ]
      : [
          process.env.DATABASE_URL,
          process.env.POSTGRES_URL,
          process.env.NEON_DATABASE_URL,
          process.env.SUPABASE_POOLER_URL,
          process.env.SUPABASE_DB_URL
        ];

  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }

  return '';
};

const getPostgresPool = (): PgPool | null => {
  if (pgPool !== undefined) return pgPool;

  const connectionString = resolvePostgresConnectionString();
  if (!connectionString) {
    pgPool = null;
    return pgPool;
  }

  preferIpv4();

  pgPool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: POSTGRES_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true
  });

  if (!pgPoolErrorHandlerBound && pgPool) {
    const pool = pgPool;
    pool.on('error', (error: Error) => {
      console.warn('Postgres pool error:', getErrorMessage(error));
    });
    pgPoolErrorHandlerBound = true;
  }

  return pgPool || null;
};

const quoteIdentifier = (value: string) => `"${String(value || '').replace(/"/g, '""')}"`;

const uniqueStrings = (values: unknown[]) =>
  Array.from(
    new Set(
      values
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  );

const getPostgresCircuitRetryAfterMs = () => Math.max(pgCircuitOpenUntil - Date.now(), 0);

const isPostgresCircuitOpen = () => getPostgresCircuitRetryAfterMs() > 0;

const getPostgresHealthState = () => ({
  circuitOpen: isPostgresCircuitOpen(),
  retryAfterMs: getPostgresCircuitRetryAfterMs(),
  lastFailureAt: pgLastFailureAt ? new Date(pgLastFailureAt).toISOString() : null,
  lastFailureMessage: pgLastFailureMessage
});

const isPostgresAvailabilityError = (error: unknown) => {
  const message = getErrorMessage(error, '').toLowerCase();
  const code = String((error as { code?: unknown } | null)?.code || '').trim().toUpperCase();
  return (
    message.includes('data transfer quota') ||
    message.includes('quota exceeded') ||
    message.includes('temporarily unavailable') ||
    message.includes('connection failed') ||
    message.includes('connection terminated') ||
    message.includes('timeout') ||
    code.startsWith('ECONN') ||
    code === 'ETIMEDOUT'
  );
};

const isPostgresCircuitBreakerError = (error: unknown) => {
  const message = getErrorMessage(error, '').toLowerCase();
  return (
    message.includes('data transfer quota') ||
    message.includes('quota exceeded') ||
    message.includes('project has been suspended') ||
    message.includes('database is suspended')
  );
};

const isPostgresTransientConnectionError = (error: unknown) => {
  const message = getErrorMessage(error, '').toLowerCase();
  const code = String((error as { code?: unknown } | null)?.code || '').trim().toUpperCase();
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    message.includes('connect econnrefused') ||
    message.includes('connection terminated') ||
    message.includes('timeout')
  );
};

const markPostgresSuccess = () => {
  pgCircuitOpenUntil = 0;
  pgLastFailureAt = 0;
  pgLastFailureMessage = null;
};

const markPostgresFailure = (error: unknown) => {
  if (!isPostgresAvailabilityError(error)) return;
  pgLastFailureAt = Date.now();
  pgLastFailureMessage = getErrorMessage(error, 'Postgres request failed');
  if (isPostgresCircuitBreakerError(error)) {
    pgCircuitOpenUntil = Math.max(pgCircuitOpenUntil, pgLastFailureAt + POSTGRES_CIRCUIT_BREAKER_MS);
  }
};

const buildPostgresCircuitError = () => ({
  message: `Postgres temporarily unavailable: ${pgLastFailureMessage || 'recent database failure'}; retry in ${Math.ceil(
    getPostgresCircuitRetryAfterMs() / 1000
  )}s`,
  code: 'service_unavailable',
  details: null,
  hint: null,
  status: 503
});

const splitTopLevel = (value: string, separator = ',') => {
  const output: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of String(value || '')) {
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(depth - 1, 0);

    if (char === separator && depth === 0) {
      const next = current.trim();
      if (next) output.push(next);
      current = '';
      continue;
    }

    current += char;
  }

  const tail = current.trim();
  if (tail) output.push(tail);
  return output;
};

const parseSelectSpec = (input?: string): SelectSpec => {
  const raw = String(input || '*').trim();
  if (!raw || raw === '*') {
    return { baseAll: true, baseFields: [], relations: [] };
  }

  const tokens = splitTopLevel(raw);
  let baseAll = false;
  const baseFields: string[] = [];
  const relations: RelationSelect[] = [];

  for (const token of tokens) {
    if (token === '*') {
      baseAll = true;
      continue;
    }

    const aliasedMatch = token.match(/^([a-zA-Z_][\w]*)\s*:\s*([a-zA-Z_][\w]*)\s*\(([\s\S]*)\)$/);
    if (aliasedMatch) {
      relations.push({
        alias: String(aliasedMatch[1] || ''),
        table: String(aliasedMatch[2] || ''),
        fields: splitTopLevel(String(aliasedMatch[3] || '')).map((field) => field.trim()).filter(Boolean)
      });
      continue;
    }

    const relationMatch = token.match(/^([a-zA-Z_][\w]*)\s*\(([\s\S]*)\)$/);
    if (relationMatch) {
      relations.push({
        alias: String(relationMatch[1] || ''),
        table: String(relationMatch[1] || ''),
        fields: splitTopLevel(String(relationMatch[2] || '')).map((field) => field.trim()).filter(Boolean)
      });
      continue;
    }

    baseFields.push(token.trim());
  }

  return {
    baseAll,
    baseFields: uniqueStrings(baseFields),
    relations
  };
};

const parseValueList = (raw: string) => {
  const inner = String(raw || '').trim().replace(/^\(/, '').replace(/\)$/, '');
  if (!inner) return [];
  const tokens: string[] = [];
  let current = '';
  let inQuote = false;

  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (char === ',' && !inQuote) {
      const token = current.trim();
      if (token) tokens.push(token);
      current = '';
      continue;
    }
    current += char;
  }

  const tail = current.trim();
  if (tail) tokens.push(tail);
  return tokens.map((token) => token.replace(/\\"/g, '"').trim());
};

const normalizeDbError = (error: any) => ({
  message: getErrorMessage(error),
  code: String(error?.code || '').trim() || null,
  details: String(error?.detail || error?.details || '').trim() || null,
  hint: String(error?.hint || '').trim() || null,
  status: isPostgresAvailabilityError(error) ? 503 : 500
});

const isIsoNullComparison = (value: unknown) => value === null || String(value || '').trim().toLowerCase() === 'null';

const renumberSqlPlaceholders = (sql: string, offset: number) =>
  String(sql || '').replace(/\$(\d+)(?!\d)/g, (_match, indexRaw: string) => {
    const index = Number(indexRaw);
    return Number.isFinite(index) && index > 0 ? `$${offset + index}` : _match;
  });

const prepareMutationValue = (table: string, column: string, value: unknown) => {
  if (Array.isArray(value) && JSON_ARRAY_COLUMNS[table]?.has(column)) {
    return JSON.stringify(value);
  }
  return value;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getPostgresRetryDelayMs = (attempt: number) => {
  if (POSTGRES_QUERY_RETRY_BASE_MS <= 0) return 0;
  const exponentialDelay = POSTGRES_QUERY_RETRY_BASE_MS * (2 ** Math.max(attempt - 1, 0));
  return Math.min(exponentialDelay, POSTGRES_QUERY_RETRY_MAX_MS);
};

const runPostgresQuery = async (
  pool: PgPool,
  sql: string,
  params: unknown[] = []
) => {
  let attempt = 0;
  while (true) {
    try {
      return await pool.query(sql, params);
    } catch (error) {
      if (!isPostgresTransientConnectionError(error) || attempt >= POSTGRES_QUERY_RETRIES) {
        throw error;
      }
      attempt += 1;
      const delayMs = getPostgresRetryDelayMs(attempt);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }
};

class PostgresQueryBuilder {
  private readonly pool: PgPool;
  private readonly table: string;
  private operation: MutationKind = 'select';
  private filters: Array<{ sql: string; params: unknown[] }> = [];
  private selectSpec: SelectSpec = { baseAll: true, baseFields: [], relations: [] };
  private orderSpecs: OrderSpec[] = [];
  private limitValue: number | null = null;
  private countExact = false;
  private headOnly = false;
  private singleMode: 'single' | 'maybeSingle' | null = null;
  private mutationPayload: Record<string, unknown>[] | null = null;
  private upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } | null = null;
  private returningExplicit = false;

  constructor(pool: PgPool, table: string) {
    this.pool = pool;
    this.table = table;
  }

  select(fields?: string, options?: { count?: string; head?: boolean }) {
    this.selectSpec = parseSelectSpec(fields);
    this.countExact = options?.count === 'exact';
    this.headOnly = options?.head === true;
    this.returningExplicit = true;
    return this;
  }

  insert(payload: Record<string, unknown> | Array<Record<string, unknown>>) {
    this.operation = 'insert';
    this.mutationPayload = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  update(payload: Record<string, unknown>) {
    this.operation = 'update';
    this.mutationPayload = [payload];
    return this;
  }

  delete() {
    this.operation = 'delete';
    return this;
  }

  upsert(payload: Record<string, unknown> | Array<Record<string, unknown>>, options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.operation = 'upsert';
    this.mutationPayload = Array.isArray(payload) ? payload : [payload];
    this.upsertOptions = options || null;
    return this;
  }

  eq(field: string, value: unknown) {
    this.filters.push({ sql: `${quoteIdentifier(field)} = $1`, params: [value] });
    return this;
  }

  gt(field: string, value: unknown) {
    this.filters.push({ sql: `${quoteIdentifier(field)} > $1`, params: [value] });
    return this;
  }

  gte(field: string, value: unknown) {
    this.filters.push({ sql: `${quoteIdentifier(field)} >= $1`, params: [value] });
    return this;
  }

  lt(field: string, value: unknown) {
    this.filters.push({ sql: `${quoteIdentifier(field)} < $1`, params: [value] });
    return this;
  }

  lte(field: string, value: unknown) {
    this.filters.push({ sql: `${quoteIdentifier(field)} <= $1`, params: [value] });
    return this;
  }

  ilike(field: string, value: unknown) {
    this.filters.push({ sql: `${quoteIdentifier(field)} ILIKE $1`, params: [value] });
    return this;
  }

  is(field: string, value: unknown) {
    this.filters.push({
      sql: isIsoNullComparison(value) ? `${quoteIdentifier(field)} IS NULL` : `${quoteIdentifier(field)} IS NOT NULL`,
      params: []
    });
    return this;
  }

  in(field: string, values: unknown[]) {
    const normalizedValues = Array.isArray(values) ? values.filter((value) => value !== undefined) : [];
    if (!normalizedValues.length) {
      this.filters.push({ sql: '1 = 0', params: [] });
      return this;
    }
    const placeholders = normalizedValues.map((_value, index) => `$${index + 1}`).join(', ');
    this.filters.push({
      sql: `${quoteIdentifier(field)} IN (${placeholders})`,
      params: normalizedValues
    });
    return this;
  }

  not(field: string, operator: string, value: unknown) {
    const normalizedOperator = String(operator || '').trim().toLowerCase();
    if (normalizedOperator === 'is') {
      this.filters.push({
        sql: isIsoNullComparison(value) ? `${quoteIdentifier(field)} IS NOT NULL` : `${quoteIdentifier(field)} IS NULL`,
        params: []
      });
      return this;
    }

    if (normalizedOperator === 'in') {
      const values = parseValueList(String(value || ''));
      if (!values.length) return this;
      const placeholders = values.map((_entry, index) => `$${index + 1}`).join(', ');
      this.filters.push({
        sql: `${quoteIdentifier(field)} NOT IN (${placeholders})`,
        params: values
      });
      return this;
    }

    this.filters.push({
      sql: `${quoteIdentifier(field)} <> $1`,
      params: [value]
    });
    return this;
  }

  or(expression: string) {
    const parsed = this.parseOrExpression(expression);
    if (parsed.sql) {
      this.filters.push({ sql: `(${parsed.sql})`, params: parsed.params });
    }
    return this;
  }

  order(field: string, options?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orderSpecs.push({
      field,
      ascending: options?.ascending !== false,
      ...(Object.prototype.hasOwnProperty.call(options || {}, 'nullsFirst') ? { nullsFirst: Boolean(options?.nullsFirst) } : {})
    });
    return this;
  }

  limit(value: number) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      this.limitValue = Math.floor(parsed);
    }
    return this;
  }

  single() {
    this.singleMode = 'single';
    return this;
  }

  maybeSingle() {
    this.singleMode = 'maybeSingle';
    return this;
  }

  async then(resolve: (value: any) => any, reject?: (reason: any) => any) {
    try {
      return resolve(await this.execute());
    } catch (error) {
      if (reject) return reject(error);
      throw error;
    }
  }

  private buildWhereClause(startIndex = 1) {
    const params: unknown[] = [];
    const clauses = this.filters.map((filter) => {
      const sql = renumberSqlPlaceholders(filter.sql, startIndex + params.length - 1);
      params.push(...filter.params);
      return sql;
    });

    return {
      sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '',
      params
    };
  }

  private buildOrderClause() {
    if (!this.orderSpecs.length) return '';
    const parts = this.orderSpecs.map((order) => {
      const direction = order.ascending ? 'ASC' : 'DESC';
      const nullsClause =
        order.nullsFirst === undefined
          ? ''
          : order.nullsFirst
            ? ' NULLS FIRST'
            : ' NULLS LAST';
      return `${quoteIdentifier(order.field)} ${direction}${nullsClause}`;
    });
    return ` ORDER BY ${parts.join(', ')}`;
  }

  private buildLimitClause(startIndex: number) {
    if (!this.limitValue) {
      return { sql: '', params: [] as unknown[] };
    }
    return {
      sql: ` LIMIT $${startIndex}`,
      params: [this.limitValue]
    };
  }

  private buildSelectClause() {
    if (this.selectSpec.baseAll) {
      return '*';
    }

    const relationJoinColumns = this.selectSpec.relations
      .map((relation) => RELATION_DEFINITIONS[this.table]?.[relation.alias] || RELATION_DEFINITIONS[this.table]?.[relation.table])
      .filter((definition): definition is RelationDefinition => Boolean(definition))
      .map((definition) => definition.localColumn);
    const fields = uniqueStrings([...this.selectSpec.baseFields, ...relationJoinColumns]);

    return fields.length ? fields.map(quoteIdentifier).join(', ') : '*';
  }

  private async execute() {
    if (isPostgresCircuitOpen()) {
      return { data: null, error: buildPostgresCircuitError(), count: null };
    }

    try {
      let response: QueryResponse;
      switch (this.operation) {
        case 'select':
          response = await this.executeSelect();
          break;
        case 'insert':
          response = await this.executeInsert();
          break;
        case 'update':
          response = await this.executeUpdate();
          break;
        case 'delete':
          response = await this.executeDelete();
          break;
        case 'upsert':
          response = await this.executeUpsert();
          break;
        default:
          return { data: null, error: { message: 'Unsupported database operation' } };
      }
      if (!response.error || Number((response.error as { status?: unknown }).status || 0) < 500) {
        markPostgresSuccess();
      }
      return response;
    } catch (error) {
      const normalized = normalizeDbError(error);
      if (normalized.status === 503) {
        markPostgresFailure(error);
      }
      return { data: null, error: normalized, count: null };
    }
  }

  private async executeSelect(): Promise<QueryResponse> {
    const where = this.buildWhereClause(1);
    const orderClause = this.buildOrderClause();
    const limitClause = this.buildLimitClause(where.params.length + 1);

    let count: number | null = null;
    if (this.countExact) {
      const countResult = await runPostgresQuery(
        this.pool,
        `SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(this.table)}${where.sql}`,
        where.params
      );
      count = Number(countResult.rows?.[0]?.count || 0);
      if (this.headOnly) {
        return { data: null, error: null, count };
      }
    }

    const result = await runPostgresQuery(
      this.pool,
      `SELECT ${this.buildSelectClause()} FROM ${quoteIdentifier(this.table)}${where.sql}${orderClause}${limitClause.sql}`,
      [...where.params, ...limitClause.params]
    );
    let rows = result.rows.map((row: Record<string, unknown>) => ({ ...row }));

    if (this.selectSpec.relations.length) {
      rows = await this.hydrateRelations(rows);
    }

    const projectedRows = rows.map((row) => this.projectRow(row));
    return this.finalizeRows(projectedRows, count);
  }

  private async executeInsert(): Promise<QueryResponse> {
    const rows = this.mutationPayload || [];
    if (!rows.length) return { data: null, error: null };

    const columns = uniqueStrings(rows.flatMap((row) => Object.keys(row || {})));
    if (!columns.length) return { data: null, error: null };

    const params: unknown[] = [];
    const valuesSql = rows
      .map((row, rowIndex) => {
        const placeholders = columns.map((_column, columnIndex) => {
          const column = String(columns[columnIndex] || '');
          params.push(prepareMutationValue(this.table, column, (row as Record<string, unknown>)[column]));
          return `$${rowIndex * columns.length + columnIndex + 1}`;
        });
        return `(${placeholders.join(', ')})`;
      })
      .join(', ');

    const returning = this.returningExplicit ? ' RETURNING *' : '';
    const result = await runPostgresQuery(
      this.pool,
      `INSERT INTO ${quoteIdentifier(this.table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES ${valuesSql}${returning}`,
      params
    );

    if (!this.returningExplicit) {
      return { data: null, error: null };
    }

    return this.finalizeRows(result.rows.map((row: Record<string, unknown>) => this.projectRow({ ...row })), null);
  }

  private async executeUpdate(): Promise<QueryResponse> {
    const payload = this.mutationPayload?.[0] || {};
    const columns = Object.keys(payload || {}).filter((key) => (payload as Record<string, unknown>)[key] !== undefined);
    if (!columns.length) return { data: null, error: null };

    const params: unknown[] = [];
    const setClause = columns
      .map((column, index) => {
        params.push(prepareMutationValue(this.table, column, (payload as Record<string, unknown>)[column]));
        return `${quoteIdentifier(column)} = $${index + 1}`;
      })
      .join(', ');

    const where = this.buildWhereClause(params.length + 1);
    const returning = this.returningExplicit ? ' RETURNING *' : '';
    const result = await runPostgresQuery(
      this.pool,
      `UPDATE ${quoteIdentifier(this.table)} SET ${setClause}${where.sql}${returning}`,
      [...params, ...where.params]
    );

    if (!this.returningExplicit) {
      return { data: null, error: null };
    }

    return this.finalizeRows(result.rows.map((row: Record<string, unknown>) => this.projectRow({ ...row })), null);
  }

  private async executeDelete(): Promise<QueryResponse> {
    const where = this.buildWhereClause(1);
    const returning = this.returningExplicit ? ' RETURNING *' : '';
    const result = await runPostgresQuery(
      this.pool,
      `DELETE FROM ${quoteIdentifier(this.table)}${where.sql}${returning}`,
      where.params
    );

    if (!this.returningExplicit) {
      return { data: null, error: null };
    }

    return this.finalizeRows(result.rows.map((row: Record<string, unknown>) => this.projectRow({ ...row })), null);
  }

  private async executeUpsert(): Promise<QueryResponse> {
    const rows = this.mutationPayload || [];
    if (!rows.length) return { data: null, error: null };

    const columns = uniqueStrings(rows.flatMap((row) => Object.keys(row || {})));
    if (!columns.length) return { data: null, error: null };

    const params: unknown[] = [];
    const valuesSql = rows
      .map((row, rowIndex) => {
        const placeholders = columns.map((_column, columnIndex) => {
          const column = String(columns[columnIndex] || '');
          params.push(prepareMutationValue(this.table, column, (row as Record<string, unknown>)[column]));
          return `$${rowIndex * columns.length + columnIndex + 1}`;
        });
        return `(${placeholders.join(', ')})`;
      })
      .join(', ');

    const conflictColumns = uniqueStrings(String(this.upsertOptions?.onConflict || '').split(','));
    const conflictClause = conflictColumns.length
      ? ` ON CONFLICT (${conflictColumns.map(quoteIdentifier).join(', ')})`
      : '';

    const updateColumns = columns.filter((column) => !conflictColumns.includes(column));
    const conflictAction = this.upsertOptions?.ignoreDuplicates
      ? ' DO NOTHING'
      : updateColumns.length
        ? ` DO UPDATE SET ${updateColumns.map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`).join(', ')}`
        : ' DO NOTHING';

    const returning = this.returningExplicit ? ' RETURNING *' : '';
    const result = await runPostgresQuery(
      this.pool,
      `INSERT INTO ${quoteIdentifier(this.table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES ${valuesSql}${conflictClause}${conflictAction}${returning}`,
      params
    );

    if (!this.returningExplicit) {
      return { data: null, error: null };
    }

    return this.finalizeRows(result.rows.map((row: Record<string, unknown>) => this.projectRow({ ...row })), null);
  }

  private async hydrateRelations(rows: Array<Record<string, unknown>>) {
    if (!rows.length) return rows;

    const hydratedRows = rows.map((row) => ({ ...row }));

    for (const relation of this.selectSpec.relations) {
      const definition =
        RELATION_DEFINITIONS[this.table]?.[relation.alias] ||
        RELATION_DEFINITIONS[this.table]?.[relation.table];
      if (!definition) {
        hydratedRows.forEach((row) => {
          row[relation.alias] = null;
        });
        continue;
      }

      const joinIds = uniqueStrings(
        hydratedRows.map((row) => row[definition.localColumn]).filter((value) => value !== null && value !== undefined)
      );
      if (!joinIds.length) {
        hydratedRows.forEach((row) => {
          row[relation.alias] = null;
        });
        continue;
      }

      const requestedFields = uniqueStrings([definition.remoteColumn, ...relation.fields]);
      const placeholders = joinIds.map((_id, index) => `$${index + 1}`).join(', ');
      const relationResult = await runPostgresQuery(
        this.pool,
        `SELECT ${requestedFields.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(definition.table)} WHERE ${quoteIdentifier(definition.remoteColumn)} IN (${placeholders})`,
        joinIds
      );

      const relationMap = new Map<string, Record<string, unknown>>();
      for (const relationRow of relationResult.rows as Array<Record<string, unknown>>) {
        const key = String(relationRow[definition.remoteColumn] || '').trim();
        if (!key) continue;
        relationMap.set(key, relationRow);
      }

      for (const row of hydratedRows) {
        const key = String(row[definition.localColumn] || '').trim();
        const relationRow = key ? relationMap.get(key) : null;
        if (!relationRow) {
          row[relation.alias] = null;
          continue;
        }
        row[relation.alias] = relation.fields.reduce<Record<string, unknown>>((acc, field) => {
          acc[field] = relationRow[field];
          return acc;
        }, {});
      }
    }

    return hydratedRows;
  }

  private projectRow(row: Record<string, unknown>) {
    const includesBaseSelection = this.selectSpec.baseAll || this.selectSpec.baseFields.length > 0 || this.selectSpec.relations.length === 0;
    const projectedBase = this.selectSpec.baseAll || this.selectSpec.relations.length === 0
      ? { ...row }
      : this.selectSpec.baseFields.reduce<Record<string, unknown>>((acc, field) => {
        acc[field] = row[field];
        return acc;
      }, {});

    if (!includesBaseSelection) {
      return this.selectSpec.relations.reduce<Record<string, unknown>>((acc, relation) => {
        acc[relation.alias] = row[relation.alias] ?? null;
        return acc;
      }, {});
    }

    for (const relation of this.selectSpec.relations) {
      projectedBase[relation.alias] = row[relation.alias] ?? null;
    }

    if (!this.selectSpec.baseAll && this.selectSpec.relations.length > 0) {
      for (const key of Object.keys(projectedBase)) {
        if (this.selectSpec.baseFields.includes(key) || this.selectSpec.relations.some((relation) => relation.alias === key)) {
          continue;
        }
        delete projectedBase[key];
      }
    }

    return projectedBase;
  }

  private finalizeRows(rows: any[], count: number | null): QueryResponse {
    if (this.singleMode === 'single') {
      if (rows.length !== 1) {
        return {
          data: null,
          error: {
            message: rows.length ? 'Expected a single row' : 'No rows found',
            status: rows.length ? 406 : 404
          },
          count
        };
      }
      return { data: rows[0], error: null, count };
    }

    if (this.singleMode === 'maybeSingle') {
      if (rows.length > 1) {
        return {
          data: null,
          error: {
            message: 'Expected zero or one row',
            status: 406
          },
          count
        };
      }
      return { data: rows[0] || null, error: null, count };
    }

    return { data: rows, error: null, count };
  }

  private parseOrExpression(expression: string): OrParseResult {
    const tokens = splitTopLevel(expression);
    const params: unknown[] = [];
    const sqlParts = tokens
      .map((token) => this.parseOrToken(token))
      .filter((part) => Boolean(part.sql))
      .map((part) => {
        const sql = renumberSqlPlaceholders(part.sql, params.length);
        params.push(...part.params);
        return sql;
      });

    return {
      sql: sqlParts.join(' OR '),
      params
    };
  }

  private parseOrToken(token: string): OrParseResult {
    const trimmed = String(token || '').trim();
    if (!trimmed) return { sql: '', params: [] };

    const andMatch = trimmed.match(/^and\(([\s\S]*)\)$/i);
    if (andMatch) {
      const tokens = splitTopLevel(String(andMatch[1] || ''));
      const parts = tokens.map((entry) => this.parseCondition(entry)).filter((part) => Boolean(part.sql));
      const params: unknown[] = [];
      const sql = parts
        .map((part) => {
          const partSql = renumberSqlPlaceholders(part.sql, params.length);
          params.push(...part.params);
          return partSql;
        })
        .join(' AND ');
      return { sql: `(${sql})`, params };
    }

    return this.parseCondition(trimmed);
  }

  private parseCondition(token: string): OrParseResult {
    const normalized = String(token || '').trim();
    const firstDot = normalized.indexOf('.');
    const secondDot = firstDot >= 0 ? normalized.indexOf('.', firstDot + 1) : -1;
    if (firstDot <= 0 || secondDot <= firstDot) {
      return { sql: '', params: [] };
    }

    const field = normalized.slice(0, firstDot).trim();
    const operator = normalized.slice(firstDot + 1, secondDot).trim().toLowerCase();
    const value = normalized.slice(secondDot + 1).trim();

    switch (operator) {
      case 'eq':
        return { sql: `${quoteIdentifier(field)} = $1`, params: [value] };
      case 'gt':
        return { sql: `${quoteIdentifier(field)} > $1`, params: [value] };
      case 'gte':
        return { sql: `${quoteIdentifier(field)} >= $1`, params: [value] };
      case 'lt':
        return { sql: `${quoteIdentifier(field)} < $1`, params: [value] };
      case 'lte':
        return { sql: `${quoteIdentifier(field)} <= $1`, params: [value] };
      case 'is':
        return {
          sql: isIsoNullComparison(value) ? `${quoteIdentifier(field)} IS NULL` : `${quoteIdentifier(field)} IS NOT NULL`,
          params: []
        };
      default:
        return { sql: '', params: [] };
    }
  }
}

const createPostgresCompatClient = () => {
  const pool = getPostgresPool();
  if (!pool) return null;

  return {
    from(table: string) {
      return new PostgresQueryBuilder(pool, String(table || '').trim());
    }
  };
};

const testPostgresConnection = async () => {
  const pool = getPostgresPool();
  if (!pool) return false;
  try {
    await runPostgresQuery(pool, 'SELECT 1');
    markPostgresSuccess();
    return true;
  } catch (error) {
    markPostgresFailure(error);
    console.error('Postgres connection failed:', getErrorMessage(error));
    return false;
  }
};

module.exports = {
  createPostgresCompatClient,
  getPostgresHealthState,
  getPostgresPool,
  resolvePostgresConnectionString,
  testPostgresConnection
};
