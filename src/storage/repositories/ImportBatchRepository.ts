import { prepare, runInTransaction, saveDatabase } from '../database';
import { ImportBatch, QueryFilters, PaginatedResult, BatchStatus, RemarkFilters } from '../../types';
import crypto from 'crypto';

export class ImportBatchRepository {

  create(batch: Omit<ImportBatch, 'id' | 'createdAt' | 'status'> & { status?: BatchStatus }): ImportBatch {
    const id = `batch-${crypto.randomUUID()}`;
    const now = Date.now();
    const status = batch.status || BatchStatus.PENDING;
    const stmt = prepare(`
      INSERT INTO import_batches (
        id, file_name, total_count, success_count, failed_count, error_details,
        status, created_at, created_by, completed_at,
        idempotency_key, file_content_hash, is_idempotency_hit, original_batch_id, submit_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      null,
      batch.idempotencyKey || null,
      batch.fileContentHash || null,
      batch.isIdempotencyHit ? 1 : 0,
      batch.originalBatchId || null,
      batch.submitCount || 1
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

  findAllWithRemarkFilters(
    filters: QueryFilters & { batchStatus?: BatchStatus } = {},
    remarkFilters: RemarkFilters = {}
  ): PaginatedResult<ImportBatch> & { matchingBatchIds: string[] } {
    const conditions: string[] = ['1=1'];
    const params: any[] = [];

    if (filters.importBatchId) {
      conditions.push('ib.id = ?');
      params.push(filters.importBatchId);
    }
    if (filters.startTime) {
      conditions.push('ib.created_at >= ?');
      params.push(filters.startTime);
    }
    if (filters.endTime) {
      conditions.push('ib.created_at <= ?');
      params.push(filters.endTime);
    }
    if (filters.batchStatus) {
      conditions.push('ib.status = ?');
      params.push(filters.batchStatus);
    }

    if (remarkFilters.remarkStatus === 'remarked') {
      conditions.push(`EXISTS (
        SELECT 1 FROM batch_row_results br
        INNER JOIN batch_row_remarks brr ON br.import_batch_id = brr.import_batch_id AND br.row_index = brr.row_index
        WHERE br.import_batch_id = ib.id AND br.status = 'failed'
      )`);
    } else if (remarkFilters.remarkStatus === 'unremarked') {
      conditions.push(`EXISTS (
        SELECT 1 FROM batch_row_results br
        WHERE br.import_batch_id = ib.id AND br.status = 'failed'
        AND NOT EXISTS (
          SELECT 1 FROM batch_row_remarks brr
          WHERE brr.import_batch_id = br.import_batch_id AND brr.row_index = br.row_index
        )
      )`);
    }

    if (remarkFilters.handledBy || remarkFilters.remarkStartTime || remarkFilters.remarkEndTime) {
      let remarkSubQuery = `EXISTS (
        SELECT 1 FROM batch_row_results br
        INNER JOIN batch_row_remarks brr ON br.import_batch_id = brr.import_batch_id AND br.row_index = brr.row_index
        WHERE br.import_batch_id = ib.id AND br.status = 'failed'
      `;
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
        remarkSubQuery += ' AND ' + remarkConditions.join(' AND ');
      }
      remarkSubQuery += ')';
      conditions.push(remarkSubQuery);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const countStmt = prepare(`SELECT COUNT(*) as count FROM import_batches ib ${whereClause}`);
    const total = (countStmt.get(...params) as { count: number }).count;

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 50;
    const offset = (page - 1) * pageSize;

    const rows = prepare(`
      SELECT ib.* FROM import_batches ib ${whereClause}
      ORDER BY ib.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[];

    const allMatchingIds = prepare(`
      SELECT ib.id FROM import_batches ib ${whereClause}
      ORDER BY ib.created_at DESC
    `).all(...params) as Array<{ id: string }>;

    return {
      items: rows.map(this.mapToImportBatch),
      total,
      page,
      pageSize,
      matchingBatchIds: allMatchingIds.map(r => r.id),
    };
  }

  update(id: string, data: Partial<Pick<ImportBatch, 'successCount' | 'failedCount' | 'errorDetails' | 'status' | 'completedAt' | 'isIdempotencyHit' | 'originalBatchId' | 'submitCount'>>): ImportBatch | null {
    const fields: string[] = [];
    const params: any[] = [];

    if (data.successCount !== undefined) { fields.push('success_count = ?'); params.push(data.successCount); }
    if (data.failedCount !== undefined) { fields.push('failed_count = ?'); params.push(data.failedCount); }
    if (data.errorDetails !== undefined) { fields.push('error_details = ?'); params.push(data.errorDetails); }
    if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status); }
    if (data.completedAt !== undefined) { fields.push('completed_at = ?'); params.push(data.completedAt); }
    if (data.isIdempotencyHit !== undefined) { fields.push('is_idempotency_hit = ?'); params.push(data.isIdempotencyHit ? 1 : 0); }
    if (data.originalBatchId !== undefined) { fields.push('original_batch_id = ?'); params.push(data.originalBatchId || null); }
    if (data.submitCount !== undefined) { fields.push('submit_count = ?'); params.push(data.submitCount); }

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
      idempotencyKey: row.idempotency_key,
      fileContentHash: row.file_content_hash,
      isIdempotencyHit: row.is_idempotency_hit === 1,
      originalBatchId: row.original_batch_id,
      submitCount: row.submit_count,
    };
  }
}
