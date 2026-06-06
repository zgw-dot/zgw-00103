import { prepare, runInTransaction, saveDatabase } from '../database';
import { ImportBatch, QueryFilters, PaginatedResult, BatchStatus } from '../../types';
import crypto from 'crypto';

export class ImportBatchRepository {

  create(batch: Omit<ImportBatch, 'id' | 'createdAt' | 'status'> & { status?: BatchStatus }): ImportBatch {
    const id = `batch-${crypto.randomUUID()}`;
    const now = Date.now();
    const status = batch.status || BatchStatus.PENDING;
    const stmt = prepare(`
      INSERT INTO import_batches (id, file_name, total_count, success_count, failed_count, error_details, status, created_at, created_by, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      batch.fileName,
      batch.totalCount,
      batch.successCount,
      batch.failedCount,
      batch.errorDetails,
      status,
      now,
      batch.createdBy,
      null
    );
    saveDatabase();
    return { ...batch, id, status, createdAt: now };
  }

  findById(id: string): ImportBatch | null {
    const row = prepare('SELECT * FROM import_batches WHERE id = ?').get(id) as any;
    return row ? this.mapToImportBatch(row) : null;
  }

  findAll(filters: QueryFilters & { batchStatus?: BatchStatus } = {}): PaginatedResult<ImportBatch> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.importBatchId) {
      conditions.push('id = ?');
      params.push(filters.importBatchId);
    }
    if (filters.startTime) {
      conditions.push('created_at >= ?');
      params.push(filters.startTime);
    }
    if (filters.endTime) {
      conditions.push('created_at <= ?');
      params.push(filters.endTime);
    }
    if (filters.batchStatus) {
      conditions.push('status = ?');
      params.push(filters.batchStatus);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countStmt = prepare(`SELECT COUNT(*) as count FROM import_batches ${whereClause}`);
    const total = (countStmt.get(...params) as { count: number }).count;

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 50;
    const offset = (page - 1) * pageSize;

    const rows = prepare(`
      SELECT * FROM import_batches ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[];

    return {
      items: rows.map(this.mapToImportBatch),
      total,
      page,
      pageSize,
    };
  }

  update(id: string, data: Partial<Pick<ImportBatch, 'successCount' | 'failedCount' | 'errorDetails' | 'status' | 'completedAt'>>): ImportBatch | null {
    const fields: string[] = [];
    const params: any[] = [];

    if (data.successCount !== undefined) { fields.push('success_count = ?'); params.push(data.successCount); }
    if (data.failedCount !== undefined) { fields.push('failed_count = ?'); params.push(data.failedCount); }
    if (data.errorDetails !== undefined) { fields.push('error_details = ?'); params.push(data.errorDetails); }
    if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status); }
    if (data.completedAt !== undefined) { fields.push('completed_at = ?'); params.push(data.completedAt); }

    params.push(id);

    const stmt = prepare(`UPDATE import_batches SET ${fields.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);
    if (result.changes === 0) return null;
    saveDatabase();
    return this.findById(id);
  }

  updateStatus(id: string, status: BatchStatus, completedAt?: number): ImportBatch | null {
    const fields: string[] = ['status = ?'];
    const params: any[] = [status];

    if (completedAt !== undefined) {
      fields.push('completed_at = ?');
      params.push(completedAt);
    }

    params.push(id);

    const stmt = prepare(`UPDATE import_batches SET ${fields.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);
    if (result.changes === 0) return null;
    saveDatabase();
    return this.findById(id);
  }

  private mapToImportBatch(row: any): ImportBatch {
    return {
      id: row.id,
      fileName: row.file_name,
      totalCount: row.total_count,
      successCount: row.success_count,
      failedCount: row.failed_count,
      errorDetails: row.error_details,
      status: row.status as BatchStatus,
      createdAt: row.created_at,
      createdBy: row.created_by,
      completedAt: row.completed_at,
    };
  }
}
