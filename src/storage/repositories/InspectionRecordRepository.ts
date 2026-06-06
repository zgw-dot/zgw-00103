import { prepare, saveDatabase } from '../database';
import {
  InspectionRecord,
  InspectionStatus,
  InspectionFilters,
  PaginatedResult,
  InspectionTemplateDevice,
  InspectionTemplate,
} from '../../types';
import crypto from 'crypto';

export interface CreateRecordInput {
  templateId: string;
  deviceId: string;
  storeId: string;
  submittedBy: string;
  submittedAt: number;
  status: InspectionStatus;
  photos: string[];
  remark: string;
  latestReadingId?: string;
  latestReadingTemperature?: number;
  latestReadingTime?: number;
  activeAlarmId?: string;
  activeAlarmType?: string;
  activeAlarmTemperature?: number;
  activeAlarmThreshold?: number;
  timeWindowStart?: number;
  timeWindowEnd?: number;
  expectedCheckTime?: number;
  isLate: boolean;
  lateMinutes?: number;
}

export class InspectionRecordRepository {
  create(input: CreateRecordInput): InspectionRecord {
    const id = `irec-${crypto.randomUUID()}`;
    const now = Date.now();

    const stmt = prepare(`
      INSERT INTO inspection_records (
        id, template_id, device_id, store_id, submitted_by, submitted_at,
        status, photos, remark, latest_reading_id, latest_reading_temperature,
        latest_reading_time, active_alarm_id, active_alarm_type,
        active_alarm_temperature, active_alarm_threshold,
        time_window_start, time_window_end, expected_check_time,
        is_late, late_minutes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      input.templateId,
      input.deviceId,
      input.storeId,
      input.submittedBy,
      input.submittedAt,
      input.status,
      JSON.stringify(input.photos),
      input.remark,
      input.latestReadingId || null,
      input.latestReadingTemperature ?? null,
      input.latestReadingTime ?? null,
      input.activeAlarmId || null,
      input.activeAlarmType || null,
      input.activeAlarmTemperature ?? null,
      input.activeAlarmThreshold ?? null,
      input.timeWindowStart ?? null,
      input.timeWindowEnd ?? null,
      input.expectedCheckTime ?? null,
      input.isLate ? 1 : 0,
      input.lateMinutes ?? null,
      now,
      now
    );
    saveDatabase();
    return this.findById(id)!;
  }

  findById(id: string): InspectionRecord | null {
    const row = prepare('SELECT * FROM inspection_records WHERE id = ?').get(id) as any;
    return row ? this.mapToRecord(row) : null;
  }

  findByTemplateAndDevice(templateId: string, deviceId: string): InspectionRecord | null {
    const row = prepare(`
      SELECT * FROM inspection_records
      WHERE template_id = ? AND device_id = ?
    `).get(templateId, deviceId) as any;
    return row ? this.mapToRecord(row) : null;
  }

  findAll(filters: InspectionFilters = {}): PaginatedResult<InspectionRecord> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.templateId) {
      conditions.push('template_id = ?');
      params.push(filters.templateId);
    }
    if (filters.storeId) {
      conditions.push('store_id = ?');
      params.push(filters.storeId);
    }
    if (filters.deviceId) {
      conditions.push('device_id = ?');
      params.push(filters.deviceId);
    }
    if (filters.inspectionStatus) {
      conditions.push('status = ?');
      params.push(filters.inspectionStatus);
    }
    if (filters.submittedBy) {
      conditions.push('submitted_by = ?');
      params.push(filters.submittedBy);
    }
    if (filters.startTime) {
      conditions.push('submitted_at >= ?');
      params.push(filters.startTime);
    }
    if (filters.endTime) {
      conditions.push('submitted_at <= ?');
      params.push(filters.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countStmt = prepare(`SELECT COUNT(*) as count FROM inspection_records ${whereClause}`);
    const total = (countStmt.get(...params) as { count: number }).count;

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 50;
    const offset = (page - 1) * pageSize;

    const rows = prepare(`
      SELECT * FROM inspection_records ${whereClause}
      ORDER BY submitted_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[];

    return {
      items: rows.map(this.mapToRecord),
      total,
      page,
      pageSize,
    };
  }

  findAllWithDetails(
    filters: InspectionFilters = {},
    templates: Map<string, InspectionTemplate>,
    devices: Map<string, { name: string; storeId: string; storeName: string }>
  ): PaginatedResult<any> {
    const result = this.findAll(filters);
    const items = result.items.map(record => {
      const template = templates.get(record.templateId);
      const device = devices.get(record.deviceId);
      let deviceConfig: InspectionTemplateDevice | undefined;

      if (template) {
        deviceConfig = template.devices.find(d => d.deviceId === record.deviceId);
      }

      return {
        ...record,
        templateName: template?.name,
        shift: template?.shift,
        templateDate: template?.date,
        deviceName: device?.name,
        personInCharge: deviceConfig?.personInCharge,
        photoRequirement: deviceConfig?.photoRequirement,
        remarkRequirement: deviceConfig?.remarkRequirement,
      };
    });

    return { ...result, items };
  }

  countByStatus(status: InspectionStatus): number {
    const result = prepare(`
      SELECT COUNT(*) as count FROM inspection_records WHERE status = ?
    `).get(status) as { count: number };
    return result?.count || 0;
  }

  countByFilters(filters: InspectionFilters = {}): { total: number; submitted: number; late: number; missed: number; pending: number } {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.templateId) {
      conditions.push('template_id = ?');
      params.push(filters.templateId);
    }
    if (filters.storeId) {
      conditions.push('store_id = ?');
      params.push(filters.storeId);
    }
    if (filters.deviceId) {
      conditions.push('device_id = ?');
      params.push(filters.deviceId);
    }
    if (filters.startTime) {
      conditions.push('submitted_at >= ?');
      params.push(filters.startTime);
    }
    if (filters.endTime) {
      conditions.push('submitted_at <= ?');
      params.push(filters.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) as submitted,
        SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) as late,
        SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END) as missed,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
      FROM inspection_records ${whereClause}
    `).get(...params) as any;

    return {
      total: result?.total || 0,
      submitted: result?.submitted || 0,
      late: result?.late || 0,
      missed: result?.missed || 0,
      pending: result?.pending || 0,
    };
  }

  private mapToRecord(row: any): InspectionRecord {
    let photos: string[] = [];
    try {
      photos = JSON.parse(row.photos || '[]');
    } catch {
      photos = [];
    }

    return {
      id: row.id,
      templateId: row.template_id,
      deviceId: row.device_id,
      storeId: row.store_id,
      submittedBy: row.submitted_by,
      submittedAt: row.submitted_at,
      status: row.status as InspectionStatus,
      photos,
      remark: row.remark,
      latestReadingId: row.latest_reading_id,
      latestReadingTemperature: row.latest_reading_temperature,
      latestReadingTime: row.latest_reading_time,
      activeAlarmId: row.active_alarm_id,
      activeAlarmType: row.active_alarm_type,
      activeAlarmTemperature: row.active_alarm_temperature,
      activeAlarmThreshold: row.active_alarm_threshold,
      timeWindowStart: row.time_window_start,
      timeWindowEnd: row.time_window_end,
      expectedCheckTime: row.expected_check_time,
      isLate: row.is_late === 1,
      lateMinutes: row.late_minutes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
