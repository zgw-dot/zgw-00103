import { prepare, runInTransaction, saveDatabase } from '../database';
import { BatchRowResult, RowStatus, QueryFilters, PaginatedResult, RemarkFilters } from '../../types';
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

  findByBatchIdWithRemarkFilters(
    batchId: string,
    filters: QueryFilters = {},
    remarkFilters: RemarkFilters = {}
  ): PaginatedResult<BatchRowResult> {
    const conditions: string[] = ['br.import_batch_id = ?'];
    const params: any[] = [batchId];

    if (filters.rowStatus) {
      conditions.push('br.status = ?');
      params.push(filters.rowStatus);
    }
    if (filters.deviceId) {
      conditions.push('br.device_id = ?');
      params.push(filters.deviceId);
    }

    if (remarkFilters.remarkStatus === 'remarked') {
      conditions.push('EXISTS (SELECT 1 FROM batch_row_remarks brr WHERE brr.import_batch_id = br.import_batch_id AND brr.row_index = br.row_index)');
    } else if (remarkFilters.remarkStatus === 'unremarked') {
      conditions.push('br.status = ?');
      params.push('failed');
      conditions.push('NOT EXISTS (SELECT 1 FROM batch_row_remarks brr WHERE brr.import_batch_id = br.import_batch_id AND brr.row_index = br.row_index)');
    }

    if (remarkFilters.handledBy || remarkFilters.remarkStartTime || remarkFilters.remarkEndTime) {
      conditions.push('EXISTS (SELECT 1 FROM batch_row_remarks brr WHERE brr.import_batch_id = br.import_batch_id AND brr.row_index = br.row_index');
      const remarkConditions: string[] = [];
      if (remarkFilters.handledBy) {
        remarkConditions.push('brr.handled_by = ?');
        params.push(remarkFilters.handledBy);
      }
      if (remarkFilters.remarkStartTime) {
        remarkConditions.push('brr.handled_at >= ?');
        params.push(remarkFilters.remarkStartTime);
      }
      if (remarkFilters.remarkEndTime) {
        remarkConditions.push('brr.handled_at <= ?');
        params.push(remarkFilters.remarkEndTime);
      }
      if (remarkConditions.length > 0) {
        conditions[conditions.length - 1] += ' AND ' + remarkConditions.join(' AND ') + ')';
      } else {
        conditions[conditions.length - 1] += ')';
      }
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const countStmt = prepare(`SELECT COUNT(*) as count FROM batch_row_results br ${whereClause}`);
    const total = (countStmt.get(...params) as { count: number }).count;

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 100;
    const offset = (page - 1) * pageSize;

    const rows = prepare(`
      SELECT br.* FROM batch_row_results br ${whereClause}
      ORDER BY br.row_index ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[];

    return {
      items: rows.map(this.mapToBatchRowResult),
      total,
      page,
      pageSize,
    };
  }

  findAllByBatchIdWithRemarkFilters(
    batchId: string,
    filters: QueryFilters = {},
    remarkFilters: RemarkFilters = {}
  ): BatchRowResult[] {
    const conditions: string[] = ['br.import_batch_id = ?'];
    const params: any[] = [batchId];

    if (filters.rowStatus) {
      conditions.push('br.status = ?');
      params.push(filters.rowStatus);
    }
    if (filters.deviceId) {
      conditions.push('br.device_id = ?');
      params.push(filters.deviceId);
    }

    if (remarkFilters.remarkStatus === 'remarked') {
      conditions.push('EXISTS (SELECT 1 FROM batch_row_remarks brr WHERE brr.import_batch_id = br.import_batch_id AND brr.row_index = br.row_index)');
    } else if (remarkFilters.remarkStatus === 'unremarked') {
      conditions.push('br.status = ?');
      params.push('failed');
      conditions.push('NOT EXISTS (SELECT 1 FROM batch_row_remarks brr WHERE brr.import_batch_id = br.import_batch_id AND brr.row_index = br.row_index)');
    }

    if (remarkFilters.handledBy || remarkFilters.remarkStartTime || remarkFilters.remarkEndTime) {
      conditions.push('EXISTS (SELECT 1 FROM batch_row_remarks brr WHERE brr.import_batch_id = br.import_batch_id AND brr.row_index = br.row_index');
      const remarkConditions: string[] = [];
      if (remarkFilters.handledBy) {
        remarkConditions.push('brr.handled_by = ?');
        params.push(remarkFilters.handledBy);
      }
      if (remarkFilters.remarkStartTime) {
        remarkConditions.push('brr.handled_at >= ?');
        params.push(remarkFilters.remarkStartTime);
      }
      if (remarkFilters.remarkEndTime) {
        remarkConditions.push('brr.handled_at <= ?');
        params.push(remarkFilters.remarkEndTime);
      }
      if (remarkConditions.length > 0) {
        conditions[conditions.length - 1] += ' AND ' + remarkConditions.join(' AND ') + ')';
      } else {
        conditions[conditions.length - 1] += ')';
      }
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const rows = prepare(`
      SELECT br.* FROM batch_row_results br ${whereClause}
      ORDER BY br.row_index ASC
    `).all(...params) as any[];

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
