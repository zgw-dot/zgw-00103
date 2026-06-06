import { prepare, runInTransaction, saveDatabase } from '../database';
import { BatchRowRemark, BatchRowRemarkStats } from '../../types';
import crypto from 'crypto';

export class BatchRowRemarkRepository {

  upsert(remark: Omit<BatchRowRemark, 'id' | 'createdAt' | 'updatedAt'>): { remark: BatchRowRemark; isNew: boolean } {
    const now = Date.now();
    const existing = this.findByBatchIdAndRowIndex(remark.importBatchId, remark.rowIndex);

    if (existing) {
      const stmt = prepare(`
        UPDATE batch_row_remarks
        SET remark_content = ?, handled_by = ?, handled_at = ?, updated_at = ?
        WHERE import_batch_id = ? AND row_index = ?
      `);
      stmt.run(
        remark.remarkContent,
        remark.handledBy,
        remark.handledAt,
        now,
        remark.importBatchId,
        remark.rowIndex
      );
      saveDatabase();
      const updated = this.findByBatchIdAndRowIndex(remark.importBatchId, remark.rowIndex)!;
      return { remark: updated, isNew: false };
    } else {
      const id = `remark-${crypto.randomUUID()}`;
      const stmt = prepare(`
        INSERT INTO batch_row_remarks (
          id, import_batch_id, row_index, remark_content,
          handled_by, handled_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        remark.importBatchId,
        remark.rowIndex,
        remark.remarkContent,
        remark.handledBy,
        remark.handledAt,
        now,
        now
      );
      saveDatabase();
      return { remark: { ...remark, id, createdAt: now, updatedAt: now }, isNew: true };
    }
  }

  findByBatchIdAndRowIndex(batchId: string, rowIndex: number): BatchRowRemark | null {
    const row = prepare(`
      SELECT * FROM batch_row_remarks
      WHERE import_batch_id = ? AND row_index = ?
    `).get(batchId, rowIndex) as any;
    return row ? this.mapToBatchRowRemark(row) : null;
  }

  findByBatchId(batchId: string): BatchRowRemark[] {
    const rows = prepare(`
      SELECT * FROM batch_row_remarks
      WHERE import_batch_id = ?
      ORDER BY row_index ASC
    `).all(batchId) as any[];
    return rows.map(this.mapToBatchRowRemark);
  }

  deleteByBatchIdAndRowIndex(batchId: string, rowIndex: number): boolean {
    const stmt = prepare(`
      DELETE FROM batch_row_remarks
      WHERE import_batch_id = ? AND row_index = ?
    `);
    const result = stmt.run(batchId, rowIndex);
    saveDatabase();
    return result.changes > 0;
  }

  getRemarkStatsForBatch(batchId: string): BatchRowRemarkStats {
    const failedRowCount = prepare(`
      SELECT COUNT(*) as count FROM batch_row_results
      WHERE import_batch_id = ? AND status = 'failed'
    `).get(batchId) as { count: number };

    const remarkedRowCount = prepare(`
      SELECT COUNT(DISTINCT brr.row_index) as count
      FROM batch_row_remarks brr
      INNER JOIN batch_row_results br ON br.import_batch_id = brr.import_batch_id AND br.row_index = brr.row_index
      WHERE brr.import_batch_id = ? AND br.status = 'failed'
    `).get(batchId) as { count: number };

    const totalFailed = failedRowCount?.count || 0;
    const remarked = remarkedRowCount?.count || 0;

    return {
      totalFailedRows: totalFailed,
      remarkedRows: remarked,
      unremarkedRows: totalFailed - remarked,
    };
  }

  private mapToBatchRowRemark(row: any): BatchRowRemark {
    return {
      id: row.id,
      importBatchId: row.import_batch_id,
      rowIndex: row.row_index,
      remarkContent: row.remark_content,
      handledBy: row.handled_by,
      handledAt: row.handled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
