import { prepare, runInTransaction, saveDatabase } from '../database';
import { BatchRowResult, RowStatus, QueryFilters, PaginatedResult } from '../../types';
import crypto from 'crypto';

export class BatchRowResultRepository {

  create(row: Omit<BatchRowResult, 'id' | 'createdAt'>): BatchRowResult {
    const id = `row-${crypto.randomUUID()}`;
    const now = Date.now();
    const stmt = prepare(`
      INSERT INTO batch_row_results (
        id, import_batch_id, row_index, device_id, temperature,
        reading_time, status, error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      row.importBatchId,
      row.rowIndex,
      row.deviceId,
      row.temperature ?? null,
      row.readingTime ?? null,
      row.status,
      row.errorMessage ?? null,
      now
    );
    saveDatabase();
    return { ...row, id, createdAt: now };
  }

  createMany(rows: Array<Omit<BatchRowResult, 'id' | 'createdAt'>>): BatchRowResult[] {
    const now = Date.now();
    const results: BatchRowResult[] = [];
    for (const row of rows) {
      const id = `row-${crypto.randomUUID()}`;
      const stmt = prepare(`
        INSERT INTO batch_row_results (
          id, import_batch_id, row_index, device_id, temperature,
          reading_time, status, error_message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        row.importBatchId,
        row.rowIndex,
        row.deviceId,
        row.temperature ?? null,
        row.readingTime ?? null,
        row.status,
        row.errorMessage ?? null,
        now
      );
      results.push({ ...row, id, createdAt: now });
    }
    saveDatabase();
    return results;
  }

  findById(id: string): BatchRowResult | null {
    const row = prepare('SELECT * FROM batch_row_results WHERE id = ?').get(id) as any;
    return row ? this.mapToBatchRowResult(row) : null;
  }

  findByBatchId(batchId: string, filters: QueryFilters = {}): PaginatedResult<BatchRowResult> {
    const conditions: string[] = ['import_batch_id = ?'];
    const params: any[] = [batchId];

    if (filters.rowStatus) {
      conditions.push('status = ?');
      params.push(filters.rowStatus);
    }
    if (filters.deviceId) {
      conditions.push('device_id = ?');
      params.push(filters.deviceId);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const countStmt = prepare(`SELECT COUNT(*) as count FROM batch_row_results ${whereClause}`);
    const total = (countStmt.get(...params) as { count: number }).count;

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 100;
    const offset = (page - 1) * pageSize;

    const rows = prepare(`
      SELECT * FROM batch_row_results ${whereClause}
      ORDER BY row_index ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[];

    return {
      items: rows.map(this.mapToBatchRowResult),
      total,
      page,
      pageSize,
    };
  }

  findAllByBatchId(batchId: string): BatchRowResult[] {
    const rows = prepare(`
      SELECT * FROM batch_row_results
      WHERE import_batch_id = ?
      ORDER BY row_index ASC
    `).all(batchId) as any[];
    return rows.map(this.mapToBatchRowResult);
  }

  deleteByBatchId(batchId: string): number {
    const stmt = prepare('DELETE FROM batch_row_results WHERE import_batch_id = ?');
    const result = stmt.run(batchId);
    saveDatabase();
    return result.changes;
  }

  private mapToBatchRowResult(row: any): BatchRowResult {
    return {
      id: row.id,
      importBatchId: row.import_batch_id,
      rowIndex: row.row_index,
      deviceId: row.device_id,
      temperature: row.temperature,
      readingTime: row.reading_time,
      status: row.status as RowStatus,
      errorMessage: row.error_message,
      createdAt: row.created_at,
    };
  }
}
