import initSqlJs, { Database } from 'sql.js';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import logger from '../utils/logger';

let db: Database | null = null;
let initPromise: Promise<Database> | null = null;

export async function getDatabase(): Promise<Database> {
  if (db) return db;

  if (initPromise) return initPromise;

  initPromise = (async () => {
    const SQL = await initSqlJs();

    const dbDir = path.dirname(config.database.path);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    let existingData: Uint8Array | null = null;
    if (fs.existsSync(config.database.path)) {
      existingData = fs.readFileSync(config.database.path);
    }

    db = existingData ? new SQL.Database(existingData) : new SQL.Database();

    db.run('PRAGMA foreign_keys = ON');

    initializeTables(db);

    logger.info('Database initialized successfully');
    return db;
  })();

  return initPromise;
}

export function getDatabaseSync(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call getDatabase() first.');
  }
  return db;
}

function initializeTables(db: Database): void {
  const createTables = [
    `CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      store_id TEXT NOT NULL,
      store_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS thresholds (
      id TEXT PRIMARY KEY,
      device_id TEXT,
      store_id TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      min_temp REAL NOT NULL,
      max_temp REAL NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      total_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      error_details TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      completed_at INTEGER,
      idempotency_key TEXT,
      file_content_hash TEXT,
      is_idempotency_hit INTEGER NOT NULL DEFAULT 0,
      original_batch_id TEXT,
      submit_count INTEGER NOT NULL DEFAULT 1
    )`,

    `CREATE TABLE IF NOT EXISTS idempotency_keys (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      operator TEXT NOT NULL,
      file_content_hash TEXT NOT NULL,
      original_batch_id TEXT NOT NULL,
      submit_count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_submit_at INTEGER NOT NULL,
      UNIQUE(idempotency_key, operator)
    )`,

    `CREATE TABLE IF NOT EXISTS batch_row_results (
      id TEXT PRIMARY KEY,
      import_batch_id TEXT NOT NULL,
      row_index INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      temperature REAL,
      reading_time INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (import_batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS temperature_readings (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      temperature REAL NOT NULL,
      reading_time INTEGER NOT NULL,
      import_batch_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(device_id, reading_time)
    )`,

    `CREATE TABLE IF NOT EXISTS alarms (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      type TEXT NOT NULL,
      threshold REAL NOT NULL,
      reading_id TEXT NOT NULL,
      reading_time INTEGER NOT NULL,
      temperature REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      acknowledged_at INTEGER,
      acknowledged_by TEXT,
      recovered_at INTEGER,
      recovered_reading_id TEXT,
      recovered_temperature REAL,
      closed_at INTEGER,
      closed_by TEXT,
      close_note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      operation_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      operator TEXT NOT NULL,
      details TEXT NOT NULL,
      store_id TEXT,
      device_id TEXT,
      import_batch_id TEXT,
      alarm_id TEXT,
      created_at INTEGER NOT NULL
    )`,

    `CREATE INDEX IF NOT EXISTS idx_alarms_device_status ON alarms(device_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_alarms_reading_time ON alarms(reading_time)`,
    `CREATE INDEX IF NOT EXISTS idx_readings_device_time ON temperature_readings(device_id, reading_time)`,
    `CREATE INDEX IF NOT EXISTS idx_batch_row_results_batch ON batch_row_results(import_batch_id)`,
    `CREATE INDEX IF NOT EXISTS idx_batch_row_results_device ON batch_row_results(device_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_device ON audit_logs(device_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_store ON audit_logs(store_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_batch ON audit_logs(import_batch_id)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_alarm ON audit_logs(alarm_id)`,
    `CREATE INDEX IF NOT EXISTS idx_import_batches_idempotency ON import_batches(idempotency_key, created_by)`,
    `CREATE INDEX IF NOT EXISTS idx_import_batches_original ON import_batches(original_batch_id)`,
    `CREATE INDEX IF NOT EXISTS idx_idempotency_keys_operator ON idempotency_keys(operator)`,
  ];

  for (const sql of createTables) {
    db.run(sql);
  }

  insertDefaultThreshold(db);
  saveDatabase();
}

function insertDefaultThreshold(db: Database): void {
  const result = db.exec('SELECT COUNT(*) as count FROM thresholds WHERE is_default = 1');
  const count = result.length > 0 ? (result[0].values[0][0] as number) : 0;

  if (count === 0) {
    const now = Date.now();
    db.run(
      `INSERT INTO thresholds (id, device_id, store_id, is_default, min_temp, max_temp, created_at, updated_at)
       VALUES (?, NULL, NULL, 1, ?, ?, ?, ?)`,
      ['default-threshold', config.defaultThreshold.minTemp, config.defaultThreshold.maxTemp, now, now]
    );
    logger.info('Default threshold inserted');
  }
}

export function saveDatabase(): void {
  if (!db) return;
  
  if (isInTransaction) {
    return;
  }

  const data = db.export();
  const buffer = Buffer.from(data);

  const tmpPath = config.database.path + '.tmp';
  fs.writeFileSync(tmpPath, buffer);
  fs.renameSync(tmpPath, config.database.path);
}

export function closeDatabase(): void {
  if (db) {
    saveDatabase();
    db.close();
    db = null;
    initPromise = null;
    logger.info('Database closed');
  }
}

let isInTransaction = false;

export function runInTransaction(fn: () => void): void {
  if (!db) throw new Error('Database not initialized');
  
  if (isInTransaction) {
    fn();
    return;
  }
  
  isInTransaction = true;
  db.run('BEGIN TRANSACTION');
  let committed = false;
  try {
    fn();
    db.run('COMMIT');
    committed = true;
  } catch (error) {
    try {
      db.run('ROLLBACK');
    } catch (rollbackError) {
      logger.warn('Rollback failed, transaction may already be closed', rollbackError);
    }
    throw error;
  } finally {
    isInTransaction = false;
    if (committed) {
      saveDatabase();
    }
  }
}

export interface Statement {
  run(...params: any[]): { changes: number };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

export function prepare(sql: string): Statement {
  if (!db) throw new Error('Database not initialized');

  const database = db;
  const stmt = database.prepare(sql);

  return {
    run(...params: any[]) {
      stmt.run(params);
      return { changes: database.getRowsModified() };
    },
    get(...params: any[]) {
      stmt.bind(params);
      if (!stmt.step()) return undefined;
      const result = stmt.getAsObject();
      stmt.reset();
      return result;
    },
    all(...params: any[]) {
      stmt.bind(params);
      const rows: any[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.reset();
      return rows;
    },
  };
}
