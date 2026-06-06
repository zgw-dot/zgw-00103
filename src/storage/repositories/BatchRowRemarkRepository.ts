import { prepare, runInTransaction, saveDatabase } from '../database';
import { BatchRowRemark, BatchRowRemarkStats, DispositionStats, RemarkFilters, BatchListDispositionStats } from '../../types';
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

  getDispositionStatsForBatch(batchId: string, filters: RemarkFilters = {}): DispositionStats {
    const failedRowCount = prepare(`
      SELECT COUNT(*) as count FROM batch_row_results
      WHERE import_batch_id = ? AND status = 'failed'
    `).get(batchId) as { count: number };

    let remarkedSql = `
      SELECT COUNT(DISTINCT brr.row_index) as count
      FROM batch_row_remarks brr
      INNER JOIN batch_row_results br ON br.import_batch_id = brr.import_batch_id AND br.row_index = brr.row_index
      WHERE brr.import_batch_id = ? AND br.status = 'failed'
    `;
    const remarkedParams: any[] = [batchId];

    if (filters.handledBy) {
      remarkedSql += ' AND brr.handled_by = ?';
      remarkedParams.push(filters.handledBy);
    }
    if (filters.remarkStartTime) {
      remarkedSql += ' AND brr.handled_at >= ?';
      remarkedParams.push(filters.remarkStartTime);
    }
    if (filters.remarkEndTime) {
      remarkedSql += ' AND brr.handled_at <= ?';
      remarkedParams.push(filters.remarkEndTime);
    }

    const remarkedRowCount = prepare(remarkedSql).get(...remarkedParams) as { count: number };

    const handlerCounts = prepare(`
      SELECT brr.handled_by as handledBy, COUNT(DISTINCT brr.row_index) as count
      FROM batch_row_remarks brr
      INNER JOIN batch_row_results br ON br.import_batch_id = brr.import_batch_id AND br.row_index = brr.row_index
      WHERE brr.import_batch_id = ? AND br.status = 'failed'
      GROUP BY brr.handled_by
      ORDER BY count DESC
    `).all(batchId) as Array<{ handledBy: string; count: number }>;

    const totalFailed = failedRowCount?.count || 0;
    const remarked = remarkedRowCount?.count || 0;

    return {
      totalFailedRows: totalFailed,
      remarkedRows: remarked,
      unremarkedRows: totalFailed - remarked,
      byHandler: handlerCounts.map(h => ({ handledBy: h.handledBy, count: h.count })),
      remarkProgress: totalFailed > 0 ? Math.round((remarked / totalFailed) * 100) : 0,
    };
  }

  findByBatchIdWithFilters(batchId: string, filters: RemarkFilters = {}): BatchRowRemark[] {
    let sql = `
      SELECT * FROM batch_row_remarks
      WHERE import_batch_id = ?
    `;
    const params: any[] = [batchId];

    if (filters.handledBy) {
      sql += ' AND handled_by = ?';
      params.push(filters.handledBy);
    }
    if (filters.remarkStartTime) {
      sql += ' AND handled_at >= ?';
      params.push(filters.remarkStartTime);
    }
    if (filters.remarkEndTime) {
      sql += ' AND handled_at <= ?';
      params.push(filters.remarkEndTime);
    }

    sql += ' ORDER BY row_index ASC';

    const rows = prepare(sql).all(...params) as any[];
    return rows.map(this.mapToBatchRowRemark);
  }

  getBatchListDispositionStats(batchIds: string[]): BatchListDispositionStats {
    if (batchIds.length === 0) {
      return {
        totalBatches: 0,
        batchesWithUnremarkedRows: 0,
        totalFailedRows: 0,
        totalRemarkedRows: 0,
        totalUnremarkedRows: 0,
        overallProgress: 0,
      };
    }

    const placeholders = batchIds.map(() => '?').join(',');

    const totalFailedResult = prepare(`
      SELECT COUNT(*) as count FROM batch_row_results
      WHERE import_batch_id IN (${placeholders}) AND status = 'failed'
    `).get(...batchIds) as { count: number };

    const totalRemarkedResult = prepare(`
      SELECT COUNT(DISTINCT br.import_batch_id || '-' || br.row_index) as count
      FROM batch_row_remarks brr
      INNER JOIN batch_row_results br ON br.import_batch_id = brr.import_batch_id AND br.row_index = brr.row_index
      WHERE brr.import_batch_id IN (${placeholders}) AND br.status = 'failed'
    `).get(...batchIds) as { count: number };

    const batchesWithUnremarkedResult = prepare(`
      SELECT COUNT(DISTINCT br.import_batch_id) as count
      FROM batch_row_results br
      WHERE br.import_batch_id IN (${placeholders}) AND br.status = 'failed'
      AND NOT EXISTS (
        SELECT 1 FROM batch_row_remarks brr
        WHERE brr.import_batch_id = br.import_batch_id AND brr.row_index = br.row_index
      )
    `).get(...batchIds) as { count: number };

    const totalFailed = totalFailedResult?.count || 0;
    const totalRemarked = totalRemarkedResult?.count || 0;

    return {
      totalBatches: batchIds.length,
      batchesWithUnremarkedRows: batchesWithUnremarkedResult?.count || 0,
      totalFailedRows: totalFailed,
      totalRemarkedRows: totalRemarked,
      totalUnremarkedRows: totalFailed - totalRemarked,
      overallProgress: totalFailed > 0 ? Math.round((totalRemarked / totalFailed) * 100) : 0,
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
