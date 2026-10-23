import path from 'path';
import fs from 'fs';
import type { Client as LibsqlClient } from '@libsql/client';

const TURSO_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const isTurso = !!TURSO_URL;

function normalizeUrl(url: string): string {
  // `libsql://` selects the native libsql driver. We deliberately use the
  // pure-JS HTTP driver instead: same latency, no native binary to ship to
  // the serverless runtime.
  if (url.startsWith('libsql://')) return 'https://' + url.slice(9);
  return url;
}

function getDbUrl(): string {
  if (isTurso) return normalizeUrl(TURSO_URL);
  const dbPath = path.join(process.cwd(), 'data', 'suman.db');
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  return `file:${dbPath}`;
}

// ---------------------------------------------------------------------------
// Public DB types
// ---------------------------------------------------------------------------

export interface DbStatement {
  sql: string;
  args?: (string | number)[];
}

export interface DbResult {
  columns: string[];
  /** Always object rows — `row.column_name` works regardless of driver path. */
  rows: Record<string, unknown>[];
  rowsAffected: number;
  lastInsertRowid?: number;
}

export interface DbTransaction {
  execute(stmt: DbStatement): Promise<DbResult>;
  /** Runs every statement in a single round trip inside the transaction. */
  batch(stmts: DbStatement[]): Promise<DbResult[]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface DbClient {
  execute(stmt: DbStatement): Promise<DbResult>;
  /** Runs every statement in a single round trip. */
  batch(stmts: DbStatement[], mode?: 'read' | 'write'): Promise<DbResult[]>;
  transaction(mode: 'read' | 'write'): Promise<DbTransaction>;
}

export function isDatabaseLockedError(err: any): boolean {
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('database is locked') ||
    msg.includes('database is busy') ||
    msg.includes('sqlite_busy') ||
    msg.includes('locking failed')
  );
}

/**
 * True when a statement failed because the schema was not in place yet
 * (missing table/column). Only those failures are retried after the
 * bootstrap, so a real query error is never executed twice.
 */
function isSchemaError(err: any): boolean {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('no such table') ||
    msg.includes('no such column') ||
    msg.includes('has no column named')
  );
}

// ---------------------------------------------------------------------------
// Result normalisation
// ---------------------------------------------------------------------------

function decodeCell(val: any): any {
  if (val === null || val === undefined) return null;
  if (typeof val !== 'object' || Array.isArray(val)) return val;
  if (val.type === 'null') return null;
  if (val.type === 'integer' || val.type === 'float') return Number(val.value);
  return val.value;
}

/**
 * Normalise a driver result set into object rows.
 * The HTTP driver returns object rows for `execute()` but array rows for
 * `batch()`, so both shapes are handled here.
 */
function toDbResult(raw: any): DbResult {
  const columns: string[] = raw?.columns || [];
  const rawRows: any[] = raw?.rows || [];
  const rows = rawRows.map((row: any) => {
    if (row && typeof row === 'object' && !Array.isArray(row)) return row as Record<string, unknown>;
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) obj[columns[i]] = decodeCell(row?.[i]);
    return obj;
  });
  const rid = raw?.lastInsertRowid;
  return {
    columns,
    rows,
    rowsAffected: Number(raw?.rowsAffected || 0),
    lastInsertRowid: rid === null || rid === undefined ? undefined : Number(rid),
  };
}

function toStatements(stmts: DbStatement[]): { sql: string; args: (string | number)[] }[] {
  return stmts.map((s) => ({ sql: s.sql, args: s.args || [] }));
}

/** Thin adapter over @libsql/client exposing the shape used across the app. */
class DbAdapter implements DbClient {
  private raw: LibsqlClient;

  constructor(raw: LibsqlClient) {
    this.raw = raw;
  }

  async execute(stmt: DbStatement): Promise<DbResult> {
    try {
      return toDbResult(await this.raw.execute({ sql: stmt.sql, args: stmt.args || [] }));
    } catch (err: any) {
      // The schema may not have been bootstrapped yet (fresh database).
      // Wait for it and retry — only for missing table/column errors.
      if (bootstrapDepth > 0 || !isSchemaError(err)) throw err;
      await ensureSchemaReady();
      return toDbResult(await this.raw.execute({ sql: stmt.sql, args: stmt.args || [] }));
    }
  }

  async batch(stmts: DbStatement[], mode: 'read' | 'write' = 'write'): Promise<DbResult[]> {
    try {
      const results = await this.raw.batch(toStatements(stmts), mode);
      return results.map(toDbResult);
    } catch (err: any) {
      if (bootstrapDepth > 0 || !isSchemaError(err)) throw err;
      await ensureSchemaReady();
      const results = await this.raw.batch(toStatements(stmts), mode);
      return results.map(toDbResult);
    }
  }

  async transaction(mode: 'read' | 'write'): Promise<DbTransaction> {
    await ensureSchemaReady();
    const tx = await this.raw.transaction(mode);
    return {
      execute: async (stmt: DbStatement) => toDbResult(await tx.execute({ sql: stmt.sql, args: stmt.args || [] })),
      batch: async (stmts: DbStatement[]) =>
        (await tx.batch(toStatements(stmts))).map(toDbResult),
      commit: async () => {
        await tx.commit();
      },
      rollback: async () => {
        await tx.rollback();
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Tables and indexes — every statement is idempotent, so they run as one batch. */
const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS dates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date_id INTEGER NOT NULL,
    time TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (date_id) REFERENCES dates(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id TEXT UNIQUE NOT NULL,
    date_id INTEGER NOT NULL,
    slot_id INTEGER NOT NULL,
    passenger_count INTEGER NOT NULL,
    amount REAL NOT NULL,
    payment_status TEXT NOT NULL DEFAULT 'pending',
    payment_id TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (date_id) REFERENCES dates(id),
    FOREIGN KEY (slot_id) REFERENCES slots(id)
  )`,
  `CREATE TABLE IF NOT EXISTS passengers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mobile TEXT NOT NULL,
    gender TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (booking_id) REFERENCES bookings(booking_id)
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  // Internal bookkeeping (schema version). Kept out of `settings` so the
  // admin settings screen only ever shows real application settings.
  `CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS payment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    razorpay_order_id TEXT NOT NULL DEFAULT '',
    razorpay_payment_id TEXT NOT NULL DEFAULT '',
    event TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL DEFAULT 0,
    signature_valid INTEGER NOT NULL DEFAULT 0,
    booking_id TEXT NOT NULL DEFAULT '',
    raw_payload TEXT NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_payment_events_order ON payment_events(razorpay_order_id)',
  'CREATE INDEX IF NOT EXISTS idx_payment_events_booking ON payment_events(booking_id)',
  `CREATE TABLE IF NOT EXISTS slots_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_id INTEGER NOT NULL,
    date_id INTEGER NOT NULL,
    time TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    vehicle_time TEXT DEFAULT '',
    expiry_days INTEGER DEFAULT 3,
    expires_at TEXT DEFAULT '',
    date TEXT DEFAULT '',
    archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_slots_history_date ON slots_history(date)',
  // Vehicles assigned to exam slots (one slot can have multiple vehicles).
  // booked_seats is the source of truth for availability:
  // available = total_seats - booked_seats.
  `CREATE TABLE IF NOT EXISTS vehicles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slot_id INTEGER NOT NULL,
    vehicle_type TEXT NOT NULL DEFAULT '',
    vehicle_number TEXT NOT NULL DEFAULT '',
    driver_name TEXT DEFAULT '',
    driver_mobile TEXT DEFAULT '',
    departure_time TEXT NOT NULL DEFAULT '',
    arrival_time TEXT NOT NULL DEFAULT '',
    total_seats INTEGER NOT NULL DEFAULT 0,
    booked_seats INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'available',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (slot_id) REFERENCES slots(id) ON DELETE CASCADE
  )`,
  'CREATE INDEX IF NOT EXISTS idx_vehicles_slot_id ON vehicles(slot_id)',
  // Exam centres shown in the booking flow. Admin-managed so new centres can
  // be added without a code change.
  `CREATE TABLE IF NOT EXISTS exam_centers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_slots_date_id_time ON slots(date_id, time)',
  'CREATE INDEX IF NOT EXISTS idx_slots_date_id ON slots(date_id)',
  'CREATE INDEX IF NOT EXISTS idx_bookings_booking_id ON bookings(booking_id)',
  'CREATE INDEX IF NOT EXISTS idx_passengers_booking_id ON passengers(booking_id)',
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id TEXT NOT NULL,
    action TEXT NOT NULL,
    admin_email TEXT NOT NULL,
    previous_payment_status TEXT DEFAULT '',
    new_payment_status TEXT DEFAULT '',
    previous_booking_status TEXT DEFAULT '',
    new_booking_status TEXT DEFAULT '',
    details TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
];

/**
 * Columns added after the initial schema. Each one is applied only when it is
 * actually missing, so the whole list runs as a single batch instead of one
 * failing ALTER per statement.
 */
const COLUMN_MIGRATIONS: { table: string; column: string; sql: string }[] = [
  { table: 'bookings', column: 'utr_number', sql: "ALTER TABLE bookings ADD COLUMN utr_number TEXT DEFAULT ''" },
  { table: 'slots', column: 'vehicle_time', sql: "ALTER TABLE slots ADD COLUMN vehicle_time TEXT DEFAULT ''" },
  { table: 'bookings', column: 'exam_center', sql: "ALTER TABLE bookings ADD COLUMN exam_center TEXT NOT NULL DEFAULT ''" },
  { table: 'bookings', column: 'payment_timestamp', sql: 'ALTER TABLE bookings ADD COLUMN payment_timestamp DATETIME DEFAULT NULL' },
  { table: 'bookings', column: 'razorpay_order_id', sql: "ALTER TABLE bookings ADD COLUMN razorpay_order_id TEXT DEFAULT ''" },
  { table: 'bookings', column: 'razorpay_payment_id', sql: "ALTER TABLE bookings ADD COLUMN razorpay_payment_id TEXT DEFAULT ''" },
  { table: 'bookings', column: 'customer_name', sql: "ALTER TABLE bookings ADD COLUMN customer_name TEXT DEFAULT ''" },
  { table: 'bookings', column: 'customer_mobile', sql: "ALTER TABLE bookings ADD COLUMN customer_mobile TEXT DEFAULT ''" },
  { table: 'bookings', column: 'customer_email', sql: "ALTER TABLE bookings ADD COLUMN customer_email TEXT DEFAULT ''" },
  { table: 'bookings', column: 'serial_number', sql: 'ALTER TABLE bookings ADD COLUMN serial_number INTEGER DEFAULT NULL' },
  { table: 'bookings', column: 'razorpay_status', sql: "ALTER TABLE bookings ADD COLUMN razorpay_status TEXT DEFAULT ''" },
  { table: 'bookings', column: 'razorpay_method', sql: "ALTER TABLE bookings ADD COLUMN razorpay_method TEXT DEFAULT ''" },
  { table: 'bookings', column: 'razorpay_bank_ref', sql: "ALTER TABLE bookings ADD COLUMN razorpay_bank_ref TEXT DEFAULT ''" },
  { table: 'bookings', column: 'receipt_token', sql: "ALTER TABLE bookings ADD COLUMN receipt_token TEXT DEFAULT ''" },
  { table: 'bookings', column: 'confirmed_by', sql: "ALTER TABLE bookings ADD COLUMN confirmed_by TEXT DEFAULT ''" },
  { table: 'bookings', column: 'confirmation_type', sql: "ALTER TABLE bookings ADD COLUMN confirmation_type TEXT DEFAULT 'auto'" },
  { table: 'bookings', column: 'confirmed_at', sql: 'ALTER TABLE bookings ADD COLUMN confirmed_at DATETIME DEFAULT NULL' },
  { table: 'bookings', column: 'vehicle_id', sql: 'ALTER TABLE bookings ADD COLUMN vehicle_id INTEGER DEFAULT NULL' },
  { table: 'bookings', column: 'vehicle_type', sql: "ALTER TABLE bookings ADD COLUMN vehicle_type TEXT DEFAULT ''" },
  { table: 'bookings', column: 'vehicle_number', sql: "ALTER TABLE bookings ADD COLUMN vehicle_number TEXT DEFAULT ''" },
  { table: 'bookings', column: 'vehicle_departure_time', sql: "ALTER TABLE bookings ADD COLUMN vehicle_departure_time TEXT DEFAULT ''" },
  { table: 'bookings', column: 'vehicle_arrival_time', sql: "ALTER TABLE bookings ADD COLUMN vehicle_arrival_time TEXT DEFAULT ''" },
  { table: 'slots', column: 'expiry_days', sql: 'ALTER TABLE slots ADD COLUMN expiry_days INTEGER DEFAULT 3' },
  { table: 'slots', column: 'expires_at', sql: "ALTER TABLE slots ADD COLUMN expires_at TEXT DEFAULT ''" },
  { table: 'slots', column: 'status', sql: "ALTER TABLE slots ADD COLUMN status TEXT DEFAULT 'active'" },
  { table: 'slots', column: 'exam_name', sql: "ALTER TABLE slots ADD COLUMN exam_name TEXT DEFAULT ''" },
  { table: 'slots', column: 'reporting_time', sql: "ALTER TABLE slots ADD COLUMN reporting_time TEXT DEFAULT ''" },
  { table: 'slots', column: 'pickup_location', sql: "ALTER TABLE slots ADD COLUMN pickup_location TEXT DEFAULT ''" },
  { table: 'slots', column: 'drop_location', sql: "ALTER TABLE slots ADD COLUMN drop_location TEXT DEFAULT ''" },
  { table: 'slots', column: 'price', sql: 'ALTER TABLE slots ADD COLUMN price REAL DEFAULT 0' },
  { table: 'slots', column: 'description', sql: "ALTER TABLE slots ADD COLUMN description TEXT DEFAULT ''" },
];

/** Indexes that can only be created after the columns above exist. */
const LATE_INDEX_STATEMENTS: string[] = [
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_serial ON bookings(date_id, slot_id, serial_number)',
  'CREATE INDEX IF NOT EXISTS idx_bookings_receipt_token ON bookings(receipt_token)',
  'CREATE INDEX IF NOT EXISTS idx_slots_status ON slots(status)',
  'CREATE INDEX IF NOT EXISTS idx_bookings_vehicle_id ON bookings(vehicle_id)',
];

const DEFAULT_SETTINGS: Record<string, string> = {
  upi_id: '9848579053@paytm',
  upi_name: 'Suman Travels',
  price_per_ticket: '500',
  business_name: 'Suman Travels',
  business_phone: '+91 9010532226',
  business_address: 'Lalitha Nagar, NGO Colony, Nandyala, Andhra Pradesh – 518502',
  slot_expiry_days: '3',
};

const DEFAULT_EXAM_CENTERS: string[] = [
  'G. Pulla Reddy Engineering College',
  'Brindavan Institute of Technology & Science',
  'K. V. Subba Reddy Institute of Technology',
  'Poojya Educational Society',
  'Unidid Technology, Sanath Nagar, Kurnool',
];

/**
 * Bump this whenever the schema (tables, indexes or seeded data) changes.
 * A cold start reads the marker from the `settings` table and skips the whole
 * DDL bootstrap when it already matches — that is what keeps the first
 * request fast instead of paying for ~40 DDL round trips.
 */
const SCHEMA_VERSION = '1';

// ---------------------------------------------------------------------------
// Client lifecycle
// ---------------------------------------------------------------------------

let client: DbClient | null = null;
let rawClient: LibsqlClient | null = null;
let schemaReady = false;
let initPromise: Promise<void> | null = null;
let connectionSettingsApplied = false;
/** > 0 while the bootstrap runs, so its own statements are never retried. */
let bootstrapDepth = 0;

async function createRawClient(): Promise<LibsqlClient> {
  const { createClient } = await import('@libsql/client');
  const url = getDbUrl();
  if (isTurso) {
    return createClient({ url, authToken: TURSO_TOKEN || undefined });
  }
  return createClient({ url });
}

// ---------------------------------------------------------------------------
// Schema bootstrap (batched — a cold start costs ~4 round trips, not ~70)
// ---------------------------------------------------------------------------

/**
 * Run statements as one batch. If the batch fails (one bad statement aborts
 * the whole batch) fall back to running them one by one and ignore the
 * failures, so a single broken statement can never block the bootstrap.
 */
async function batchTolerant(db: DbClient, stmts: DbStatement[]): Promise<void> {
  if (stmts.length === 0) return;
  try {
    await db.batch(stmts, 'write');
  } catch (err: any) {
    console.error('[DB] Batch failed, running statements individually:', err?.message || err);
    for (const stmt of stmts) {
      try {
        await db.execute({ sql: stmt.sql, args: stmt.args });
      } catch {
        // Ignore — mirrors the old one-statement-at-a-time behaviour.
      }
    }
  }
}

async function applyColumnMigrations(db: DbClient): Promise<void> {
  const tables = Array.from(new Set(COLUMN_MIGRATIONS.map((m) => m.table)));

  const existing = new Map<string, Set<string>>();
  try {
    const results = await db.batch(
      tables.map((t) => ({ sql: `PRAGMA table_info(${t})` })),
      'read'
    );
    tables.forEach((table, i) => {
      const cols = new Set<string>();
      for (const row of results[i]?.rows || []) {
        const name = (row as any)?.name;
        if (name) cols.add(String(name));
      }
      existing.set(table, cols);
    });
  } catch (err: any) {
    console.error('[DB] Failed to read table info:', err?.message || err);
    return;
  }

  const missing = COLUMN_MIGRATIONS.filter((m) => {
    const cols = existing.get(m.table);
    // A table with no columns does not exist yet — skip its migrations.
    if (!cols || cols.size === 0) return false;
    return !cols.has(m.column);
  });
  if (missing.length === 0) return;

  try {
    await db.batch(missing.map((m) => ({ sql: m.sql })), 'write');
  } catch (err: any) {
    // Fall back to one statement at a time — an ALTER can still fail if the
    // column was added concurrently by another instance.
    console.error('[DB] Column migration batch failed, retrying individually:', err?.message || err);
    for (const m of missing) {
      try {
        await db.execute({ sql: m.sql });
      } catch {
        // Column already exists — nothing to do.
      }
    }
  }
}

async function seedExamCenters(db: DbClient): Promise<void> {
  try {
    const seededRow = await db.execute({
      sql: "SELECT value FROM settings WHERE key = 'exam_centers_seeded'",
    });
    const alreadySeeded = String((seededRow.rows?.[0] as any)?.value || '') === '1';
    if (alreadySeeded) return;

    const statements: DbStatement[] = DEFAULT_EXAM_CENTERS.map((name, i) => ({
      sql: 'INSERT OR IGNORE INTO exam_centers (name, enabled, sort_order) VALUES (?, 1, ?)',
      args: [name, i],
    }));
    statements.push({
      sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('exam_centers_seeded', '1')",
    });
    await db.batch(statements, 'write');
  } catch (err: any) {
    console.error('[DB] Failed to seed exam centers:', err?.message || err);
  }
}

async function readSchemaVersion(db: DbClient): Promise<string | null> {
  try {
    const r = await db.execute({ sql: "SELECT value FROM app_meta WHERE key = 'schema_version'" });
    const value = r.rows?.[0]?.value;
    return value ? String(value) : null;
  } catch {
    // The app_meta table does not exist yet — a full bootstrap is required.
    return null;
  }
}

async function writeSchemaVersion(db: DbClient): Promise<void> {
  try {
    await db.batch(
      [{ sql: "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', ?)", args: [SCHEMA_VERSION] }],
      'write'
    );
  } catch (err: any) {
    console.error('[DB] Failed to write schema version:', err?.message || err);
  }
}

async function ensureSchema(): Promise<void> {
  if (schemaReady) return;

  if (!client) throw new Error('Database client not initialized');

  bootstrapDepth++;
  try {
    // Fast path — the database is already at the expected schema version, so
    // skip the DDL bootstrap entirely (one cheap read instead of ~40 DDL
    // round trips). This is what keeps a cold start fast.
    const currentVersion = await readSchemaVersion(client);
    if (currentVersion === SCHEMA_VERSION) {
      await applyColumnMigrations(client);
      schemaReady = true;
      console.log('[DB] Schema up to date.');
      return;
    }

    console.log('[DB] Initializing schema...');

    // 1. Tables + indexes (single round trip).
    await batchTolerant(client, SCHEMA_STATEMENTS.map((sql) => ({ sql })));

    // 2. Missing columns (single round trip).
    await applyColumnMigrations(client);

    // 3. Indexes that depend on the new columns (single round trip).
    await batchTolerant(client, LATE_INDEX_STATEMENTS.map((sql) => ({ sql })));

    // 4. Default settings (single round trip).
    await batchTolerant(
      client,
      Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({
        sql: 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
        args: [key, value] as (string | number)[],
      }))
    );

    // 5. Exam centres — seeded exactly once.
    await seedExamCenters(client);

    // 6. Remember the schema version so future cold starts skip all of this.
    await writeSchemaVersion(client);

    schemaReady = true;
    console.log('[DB] Schema ready.');
  } catch (err: any) {
    console.error('[DB] Schema init failed:', err?.message || err);
    throw err;
  } finally {
    bootstrapDepth--;
  }
}

/**
 * Runs the schema bootstrap once. Safe to call from many places — the work
 * is shared through a single promise.
 */
async function ensureSchemaReady(): Promise<void> {
  if (schemaReady) return;
  if (!initPromise) {
    initPromise = ensureSchema().catch((err) => {
      console.error('[DB] Schema init failed:', err?.message || err);
      initPromise = null;
      schemaReady = false;
      throw err;
    });
  }
  await initPromise;
}

// Best-effort: make SQLite wait for a lock instead of failing instantly.
// Only meaningful for the local file backend; a remote Turso database has no
// local lock file, so the extra round trip is skipped there.
export async function applyConnectionSettings(): Promise<void> {
  if (connectionSettingsApplied || !client) return;
  connectionSettingsApplied = true;
  if (isTurso) return;
  try {
    await client.execute({ sql: 'PRAGMA busy_timeout = 5000' });
  } catch {
  }
}

export async function getDb(): Promise<DbClient> {
  if (!client) {
    if (isTurso) {
      console.log('[DB] Creating Turso HTTP client');
    }
    rawClient = await createRawClient();
    client = new DbAdapter(rawClient);
  }
  if (!schemaReady) {
    // The schema check runs *in parallel* with the caller's first query, so a
    // cold start costs one round trip instead of two. If the query fails
    // because the schema was missing, the adapter waits for the bootstrap and
    // retries it.
    void ensureSchemaReady().catch(() => {});
  }
  await applyConnectionSettings();
  return client;
}

export async function dbExecute(sql: string, args?: (string | number)[]): Promise<any> {
  const db = await getDb();
  try {
    return await db.execute({ sql, args });
  } catch (err: any) {
    console.error(`[DB] Execute error: ${err?.message || err}`);
    throw err;
  }
}

/** Run several statements in a single round trip. */
export async function dbBatch(
  stmts: DbStatement[],
  mode: 'read' | 'write' = 'write'
): Promise<DbResult[]> {
  const db = await getDb();
  return db.batch(stmts, mode);
}

export function rowsToObjects(result: any): Record<string, unknown>[] {
  const cols: string[] = result.columns || [];
  return (result.rows || []).map((row: any) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < cols.length; i++) {
      obj[cols[i]] = typeof row === 'object' && !Array.isArray(row) ? row[cols[i]] : decodeCell(row[i]);
    }
    return obj;
  });
}

export function rowToObject(result: any): Record<string, unknown> | null {
  if (!result || !result.rows || result.rows.length === 0) return null;
  const cols: string[] = result.columns || [];
  const row = result.rows[0];
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < cols.length; i++) {
    obj[cols[i]] = typeof row === 'object' && !Array.isArray(row) ? row[cols[i]] : decodeCell(row[i]);
  }
  return obj;
}

export async function testConnection(): Promise<{ ok: boolean; message: string }> {
  try {
    const db = await getDb();
    const r = await db.execute({ sql: 'SELECT 1 as ok' });
    return { ok: true, message: `Connected. ${r.rows.length} rows returned.` };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error('[DB] Connection test failed:', msg);
    return {
      ok: false,
      message: `Connection failed: ${msg}. TURSO_DATABASE_URL: ${TURSO_URL ? 'set' : 'NOT SET'}, TURSO_AUTH_TOKEN: ${TURSO_TOKEN ? 'set' : 'NOT SET'}`,
    };
  }
}
