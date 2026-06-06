import { prepare, runInTransaction, saveDatabase } from '../database';
import { Alarm, AlarmStatus, AlarmType, QueryFilters, PaginatedResult } from '../../types';
import crypto from 'crypto';

export class AlarmRepository {

  create(alarm: Omit<Alarm, 'id' | 'createdAt' | 'updatedAt'>): Alarm {
    const id = `al-${crypto.randomUUID()}`;
    const now = Date.now();
    const stmt = prepare(`
      INSERT INTO alarms (
        id, device_id, type, threshold, reading_id, reading_time, temperature,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      alarm.deviceId,
      alarm.type,
      alarm.threshold,
      alarm.readingId,
      alarm.readingTime,
      alarm.temperature,
      alarm.status,
      now,
      now
    );
    saveDatabase();
    return { ...alarm, id, createdAt: now, updatedAt: now };
  }

  findById(id: string): Alarm | null {
    const row = prepare('SELECT * FROM alarms WHERE id = ?').get(id) as any;
    return row ? this.mapToAlarm(row) : null;
  }

  findOpenByDevice(deviceId: string): Alarm[] {
    const rows = prepare(`
      SELECT * FROM alarms
      WHERE device_id = ? AND status IN ('open', 'acknowledged')
      ORDER BY reading_time DESC
    `).all(deviceId) as any[];
    return rows.map(this.mapToAlarm);
  }

  findAll(filters: QueryFilters = {}): PaginatedResult<Alarm> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.deviceId) {
      conditions.push('device_id = ?');
      params.push(filters.deviceId);
    }
    if (filters.alarmStatus) {
      conditions.push('status = ?');
      params.push(filters.alarmStatus);
    }
    if (filters.startTime) {
      conditions.push('reading_time >= ?');
      params.push(filters.startTime);
    }
    if (filters.endTime) {
      conditions.push('reading_time <= ?');
      params.push(filters.endTime);
    }

    if (filters.storeId) {
      conditions.push(`device_id IN (SELECT id FROM devices WHERE store_id = ?)`);
      params.push(filters.storeId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countStmt = prepare(`SELECT COUNT(*) as count FROM alarms ${whereClause}`);
    const total = (countStmt.get(...params) as { count: number }).count;

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 50;
    const offset = (page - 1) * pageSize;

    const rows = prepare(`
      SELECT * FROM alarms ${whereClause}
      ORDER BY reading_time DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[];

    return {
      items: rows.map(this.mapToAlarm),
      total,
      page,
      pageSize,
    };
  }

  updateStatus(
    id: string,
    status: AlarmStatus,
    updates: Partial<{
      acknowledgedAt: number;
      acknowledgedBy: string;
      recoveredAt: number;
      recoveredReadingId: string;
      recoveredTemperature: number;
      closedAt: number;
      closedBy: string;
      closeNote: string;
    }> = {}
  ): Alarm | null {
    const fields: string[] = ['status = ?', 'updated_at = ?'];
    const params: any[] = [status, Date.now()];

    if (updates.acknowledgedAt !== undefined) { fields.push('acknowledged_at = ?'); params.push(updates.acknowledgedAt); }
    if (updates.acknowledgedBy !== undefined) { fields.push('acknowledged_by = ?'); params.push(updates.acknowledgedBy); }
    if (updates.recoveredAt !== undefined) { fields.push('recovered_at = ?'); params.push(updates.recoveredAt); }
    if (updates.recoveredReadingId !== undefined) { fields.push('recovered_reading_id = ?'); params.push(updates.recoveredReadingId); }
    if (updates.recoveredTemperature !== undefined) { fields.push('recovered_temperature = ?'); params.push(updates.recoveredTemperature); }
    if (updates.closedAt !== undefined) { fields.push('closed_at = ?'); params.push(updates.closedAt); }
    if (updates.closedBy !== undefined) { fields.push('closed_by = ?'); params.push(updates.closedBy); }
    if (updates.closeNote !== undefined) { fields.push('close_note = ?'); params.push(updates.closeNote); }

    params.push(id);

    const stmt = prepare(`UPDATE alarms SET ${fields.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);
    if (result.changes === 0) return null;
    saveDatabase();
    return this.findById(id);
  }

  countByStatus(status: AlarmStatus): number {
    const row = prepare('SELECT COUNT(*) as count FROM alarms WHERE status = ?').get(status) as { count: number };
    return row.count;
  }

  private mapToAlarm(row: any): Alarm {
    return {
      id: row.id,
      deviceId: row.device_id,
      type: row.type as AlarmType,
      threshold: row.threshold,
      readingId: row.reading_id,
      readingTime: row.reading_time,
      temperature: row.temperature,
      status: row.status as AlarmStatus,
      acknowledgedAt: row.acknowledged_at,
      acknowledgedBy: row.acknowledged_by,
      recoveredAt: row.recovered_at,
      recoveredReadingId: row.recovered_reading_id,
      recoveredTemperature: row.recovered_temperature,
      closedAt: row.closed_at,
      closedBy: row.closed_by,
      closeNote: row.close_note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
