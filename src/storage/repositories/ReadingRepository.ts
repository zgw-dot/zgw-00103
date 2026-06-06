import { prepare, runInTransaction, saveDatabase } from '../database';
import { TemperatureReading, QueryFilters, PaginatedResult } from '../../types';
import crypto from 'crypto';

export class ReadingRepository {

  create(reading: Omit<TemperatureReading, 'id' | 'createdAt'>): TemperatureReading {
    const id = `rd-${crypto.randomUUID()}`;
    const now = Date.now();
    const stmt = prepare(`
      INSERT INTO temperature_readings (
        id, device_id, temperature, original_temperature,
        corrected_temperature, calibration_plan_id, reading_time,
        import_batch_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      reading.deviceId,
      reading.temperature,
      reading.originalTemperature,
      reading.correctedTemperature,
      reading.calibrationPlanId,
      reading.readingTime,
      reading.importBatchId,
      now
    );
    saveDatabase();
    return { ...reading, id, createdAt: now };
  }

  findById(id: string): TemperatureReading | null {
    const row = prepare('SELECT * FROM temperature_readings WHERE id = ?').get(id) as any;
    return row ? this.mapToReading(row) : null;
  }

  exists(deviceId: string, readingTime: number): boolean {
    const row = prepare(
      'SELECT 1 FROM temperature_readings WHERE device_id = ? AND reading_time = ?'
    ).get(deviceId, readingTime);
    return !!row;
  }

  findByDevice(deviceId: string, filters: QueryFilters = {}): PaginatedResult<TemperatureReading> {
    const conditions: string[] = ['device_id = ?'];
    const params: any[] = [deviceId];

    if (filters.startTime) {
      conditions.push('reading_time >= ?');
      params.push(filters.startTime);
    }
    if (filters.endTime) {
      conditions.push('reading_time <= ?');
      params.push(filters.endTime);
    }
    if (filters.importBatchId) {
      conditions.push('import_batch_id = ?');
      params.push(filters.importBatchId);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const countStmt = prepare(`SELECT COUNT(*) as count FROM temperature_readings ${whereClause}`);
    const total = (countStmt.get(...params) as { count: number }).count;

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 100;
    const offset = (page - 1) * pageSize;

    const rows = prepare(`
      SELECT * FROM temperature_readings ${whereClause}
      ORDER BY reading_time DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[];

    return {
      items: rows.map(this.mapToReading),
      total,
      page,
      pageSize,
    };
  }

  findLatestByDevice(deviceId: string): TemperatureReading | null {
    const row = prepare(`
      SELECT * FROM temperature_readings
      WHERE device_id = ?
      ORDER BY reading_time DESC
      LIMIT 1
    `).get(deviceId) as any;
    return row ? this.mapToReading(row) : null;
  }

  findAll(filters: QueryFilters = {}): PaginatedResult<TemperatureReading> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.deviceId) {
      conditions.push('device_id = ?');
      params.push(filters.deviceId);
    }
    if (filters.importBatchId) {
      conditions.push('import_batch_id = ?');
      params.push(filters.importBatchId);
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
    const countStmt = prepare(`SELECT COUNT(*) as count FROM temperature_readings ${whereClause}`);
    const total = (countStmt.get(...params) as { count: number }).count;

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 100;
    const offset = (page - 1) * pageSize;

    const rows = prepare(`
      SELECT * FROM temperature_readings ${whereClause}
      ORDER BY reading_time DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[];

    return {
      items: rows.map(this.mapToReading),
      total,
      page,
      pageSize,
    };
  }

  private mapToReading(row: any): TemperatureReading {
    return {
      id: row.id,
      deviceId: row.device_id,
      temperature: row.temperature,
      originalTemperature: row.original_temperature,
      correctedTemperature: row.corrected_temperature,
      calibrationPlanId: row.calibration_plan_id,
      readingTime: row.reading_time,
      importBatchId: row.import_batch_id,
      createdAt: row.created_at,
    };
  }
}
