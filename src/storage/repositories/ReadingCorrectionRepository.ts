import { prepare, saveDatabase } from '../database';
import { ReadingCorrection, CalibrationFilters, PaginatedResult } from '../../types';
import crypto from 'crypto';

export class ReadingCorrectionRepository {

  create(correction: Omit<ReadingCorrection, 'id' | 'createdAt'>): ReadingCorrection {
    const id = `rc-${crypto.randomUUID()}`;
    const now = Date.now();
    const stmt = prepare(`
      INSERT INTO reading_corrections (
        id, reading_id, device_id, calibration_plan_id,
        original_temperature, corrected_temperature, offset_value,
        reading_time, import_batch_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      correction.readingId,
      correction.deviceId,
      correction.calibrationPlanId,
      correction.originalTemperature,
      correction.correctedTemperature,
      correction.offsetValue,
      correction.readingTime,
      correction.importBatchId,
      now
    );
    return {
      ...correction,
      id,
      createdAt: now
    };
  }

  findById(id: string): ReadingCorrection | null {
    const row = prepare('SELECT * FROM reading_corrections WHERE id = ?').get(id) as any;
    return row ? this.mapToCorrection(row) : null;
  }

  findByReadingId(readingId: string): ReadingCorrection | null {
    const row = prepare('SELECT * FROM reading_corrections WHERE reading_id = ?').get(readingId) as any;
    return row ? this.mapToCorrection(row) : null;
  }

  findByCalibrationPlanId(planId: string, filters: CalibrationFilters = {}): PaginatedResult<ReadingCorrection> {
    const conditions: string[] = ['calibration_plan_id = ?'];
    const params: any[] = [planId];

    if (filters.deviceId) {
      conditions.push('device_id = ?');
      params.push(filters.deviceId);
    }
    if (filters.startTime) {
      conditions.push('reading_time >= ?');
      params.push(filters.startTime);
    }
    if (filters.endTime) {
      conditions.push('reading_time <= ?');
      params.push(filters.endTime);
    }

    const whereClause = conditions.join(' AND ');
    const countStmt = prepare(`SELECT COUNT(*) as count FROM reading_corrections WHERE ${whereClause}`);
    const total = (countStmt.get(...params) as { count: number }).count;

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 50;
    const offset = (page - 1) * pageSize;

    const rows = prepare(`
      SELECT * FROM reading_corrections WHERE ${whereClause}
      ORDER BY reading_time DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[];

    return {
      items: rows.map(this.mapToCorrection),
      total,
      page,
      pageSize,
    };
  }

  findByBatchId(batchId: string): ReadingCorrection[] {
    const rows = prepare(`
      SELECT * FROM reading_corrections WHERE import_batch_id = ?
      ORDER BY reading_time ASC
    `).all(batchId) as any[];
    return rows.map(this.mapToCorrection);
  }

  findAll(filters: CalibrationFilters = {}): PaginatedResult<ReadingCorrection> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.deviceId) {
      conditions.push('device_id = ?');
      params.push(filters.deviceId);
    }
    if (filters.storeId) {
      conditions.push(`device_id IN (SELECT id FROM devices WHERE store_id = ?)`);
      params.push(filters.storeId);
    }
    if (filters.startTime) {
      conditions.push('reading_time >= ?');
      params.push(filters.startTime);
    }
    if (filters.endTime) {
      conditions.push('reading_time <= ?');
      params.push(filters.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countStmt = prepare(`SELECT COUNT(*) as count FROM reading_corrections ${whereClause}`);
    const total = (countStmt.get(...params) as { count: number }).count;

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 50;
    const offset = (page - 1) * pageSize;

    const rows = prepare(`
      SELECT * FROM reading_corrections ${whereClause}
      ORDER BY reading_time DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[];

    return {
      items: rows.map(this.mapToCorrection),
      total,
      page,
      pageSize,
    };
  }

  private mapToCorrection(row: any): ReadingCorrection {
    return {
      id: row.id,
      readingId: row.reading_id,
      deviceId: row.device_id,
      calibrationPlanId: row.calibration_plan_id,
      originalTemperature: row.original_temperature,
      correctedTemperature: row.corrected_temperature,
      offsetValue: row.offset_value,
      readingTime: row.reading_time,
      importBatchId: row.import_batch_id,
      createdAt: row.created_at,
    };
  }
}
