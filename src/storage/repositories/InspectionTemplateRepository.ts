import { prepare, saveDatabase } from '../database';
import {
  InspectionTemplate,
  InspectionTemplateStatus,
  InspectionTemplateDevice,
  InspectionFilters,
  PaginatedResult,
  InspectionShift,
} from '../../types';
import crypto from 'crypto';

export interface CreateTemplateInput {
  name: string;
  storeId: string;
  storeName: string;
  shift: InspectionShift;
  date: number;
  devices: InspectionTemplateDevice[];
  createdBy: string;
}

export class InspectionTemplateRepository {
  create(input: CreateTemplateInput): InspectionTemplate {
    const id = `itpl-${crypto.randomUUID()}`;
    const now = Date.now();

    const stmt = prepare(`
      INSERT INTO inspection_templates (
        id, name, store_id, store_name, shift, date, status,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      input.name,
      input.storeId,
      input.storeName,
      input.shift,
      input.date,
      InspectionTemplateStatus.DRAFT,
      input.createdBy,
      now,
      now
    );

    for (const device of input.devices) {
      this.addTemplateDevice(id, device);
    }

    saveDatabase();
    return this.findById(id)!;
  }

  private addTemplateDevice(templateId: string, device: InspectionTemplateDevice): void {
    const id = `itd-${crypto.randomUUID()}`;
    const now = Date.now();
    const stmt = prepare(`
      INSERT INTO inspection_template_devices (
        id, template_id, device_id, time_window_start, time_window_end,
        photo_min_count, photo_required, remark_min_length, remark_required,
        person_in_charge, sort_order, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      templateId,
      device.deviceId,
      device.timeWindow.startTime,
      device.timeWindow.endTime,
      device.photoRequirement.minCount,
      device.photoRequirement.required ? 1 : 0,
      device.remarkRequirement.minLength,
      device.remarkRequirement.required ? 1 : 0,
      device.personInCharge,
      device.sortOrder,
      now
    );
  }

  findById(id: string): InspectionTemplate | null {
    const row = prepare('SELECT * FROM inspection_templates WHERE id = ?').get(id) as any;
    if (!row) return null;

    const devices = this.getTemplateDevices(id);
    return this.mapToTemplate(row, devices);
  }

  private getTemplateDevices(templateId: string): InspectionTemplateDevice[] {
    const rows = prepare(`
      SELECT * FROM inspection_template_devices
      WHERE template_id = ?
      ORDER BY sort_order ASC
    `).all(templateId) as any[];

    return rows.map(this.mapToTemplateDevice);
  }

  findAll(filters: InspectionFilters = {}): PaginatedResult<InspectionTemplate> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.templateStatus) {
      conditions.push('it.status = ?');
      params.push(filters.templateStatus);
    }
    if (filters.storeId) {
      conditions.push('it.store_id = ?');
      params.push(filters.storeId);
    }
    if (filters.shift) {
      conditions.push('it.shift = ?');
      params.push(filters.shift);
    }
    if (filters.startTime) {
      conditions.push('it.date >= ?');
      params.push(filters.startTime);
    }
    if (filters.endTime) {
      conditions.push('it.date <= ?');
      params.push(filters.endTime);
    }
    if (filters.personInCharge) {
      conditions.push('it.id IN (SELECT template_id FROM inspection_template_devices WHERE person_in_charge = ?)');
      params.push(filters.personInCharge);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countStmt = prepare(`SELECT COUNT(*) as count FROM inspection_templates it ${whereClause}`);
    const total = (countStmt.get(...params) as { count: number }).count;

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 50;
    const offset = (page - 1) * pageSize;

    const rows = prepare(`
      SELECT it.* FROM inspection_templates it ${whereClause}
      ORDER BY it.date DESC, it.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[];

    const items = rows.map(row => {
      const devices = this.getTemplateDevices(row.id);
      return this.mapToTemplate(row, devices);
    });

    return { items, total, page, pageSize };
  }

  findPublishedForStoreAtDate(storeId: string, date: number, shift: InspectionShift, excludeTemplateId?: string): InspectionTemplate[] {
    const conditions: string[] = [
      'store_id = ?',
      'date = ?',
      'shift = ?',
      'status = ?'
    ];
    const params: any[] = [storeId, date, shift, InspectionTemplateStatus.PUBLISHED];

    if (excludeTemplateId) {
      conditions.push('id != ?');
      params.push(excludeTemplateId);
    }

    const whereClause = conditions.join(' AND ');
    const rows = prepare(`
      SELECT * FROM inspection_templates
      WHERE ${whereClause}
      ORDER BY created_at DESC
    `).all(...params) as any[];

    return rows.map(row => {
      const devices = this.getTemplateDevices(row.id);
      return this.mapToTemplate(row, devices);
    });
  }

  updateStatus(
    id: string,
    status: InspectionTemplateStatus,
    updates: Partial<{
      publishedAt: number;
      publishedBy: string;
      closedAt: number;
      closedBy: string;
      closedReason: string;
      revokedAt: number;
      revokedBy: string;
      revokedReason: string;
    }> = {}
  ): InspectionTemplate | null {
    const fields: string[] = ['status = ?', 'updated_at = ?'];
    const params: any[] = [status, Date.now()];

    if (updates.publishedAt !== undefined) { fields.push('published_at = ?'); params.push(updates.publishedAt); }
    if (updates.publishedBy !== undefined) { fields.push('published_by = ?'); params.push(updates.publishedBy); }
    if (updates.closedAt !== undefined) { fields.push('closed_at = ?'); params.push(updates.closedAt); }
    if (updates.closedBy !== undefined) { fields.push('closed_by = ?'); params.push(updates.closedBy); }
    if (updates.closedReason !== undefined) { fields.push('closed_reason = ?'); params.push(updates.closedReason); }
    if (updates.revokedAt !== undefined) { fields.push('revoked_at = ?'); params.push(updates.revokedAt); }
    if (updates.revokedBy !== undefined) { fields.push('revoked_by = ?'); params.push(updates.revokedBy); }
    if (updates.revokedReason !== undefined) { fields.push('revoked_reason = ?'); params.push(updates.revokedReason); }

    params.push(id);

    const stmt = prepare(`UPDATE inspection_templates SET ${fields.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);
    if (result.changes === 0) return null;
    saveDatabase();
    return this.findById(id);
  }

  getDeviceConfig(templateId: string, deviceId: string): InspectionTemplateDevice | null {
    const row = prepare(`
      SELECT * FROM inspection_template_devices
      WHERE template_id = ? AND device_id = ?
    `).get(templateId, deviceId) as any;
    return row ? this.mapToTemplateDevice(row) : null;
  }

  getInspectionCountForTemplate(templateId: string): { total: number; submitted: number; late: number; missed: number } {
    const result = prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) as submitted,
        SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) as late,
        SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END) as missed
      FROM inspection_records
      WHERE template_id = ?
    `).get(templateId) as any;

    return {
      total: result?.total || 0,
      submitted: result?.submitted || 0,
      late: result?.late || 0,
      missed: result?.missed || 0,
    };
  }

  countByStatus(status: InspectionTemplateStatus): number {
    const result = prepare(`
      SELECT COUNT(*) as count FROM inspection_templates WHERE status = ?
    `).get(status) as { count: number };
    return result?.count || 0;
  }

  private mapToTemplateDevice(row: any): InspectionTemplateDevice {
    return {
      deviceId: row.device_id,
      timeWindow: {
        startTime: row.time_window_start,
        endTime: row.time_window_end,
      },
      photoRequirement: {
        minCount: row.photo_min_count,
        required: row.photo_required === 1,
      },
      remarkRequirement: {
        minLength: row.remark_min_length,
        required: row.remark_required === 1,
      },
      personInCharge: row.person_in_charge,
      sortOrder: row.sort_order,
    };
  }

  private mapToTemplate(row: any, devices: InspectionTemplateDevice[]): InspectionTemplate {
    return {
      id: row.id,
      name: row.name,
      storeId: row.store_id,
      storeName: row.store_name,
      shift: row.shift as InspectionShift,
      date: row.date,
      devices,
      status: row.status as InspectionTemplateStatus,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      publishedAt: row.published_at,
      publishedBy: row.published_by,
      closedAt: row.closed_at,
      closedBy: row.closed_by,
      closedReason: row.closed_reason,
      revokedAt: row.revoked_at,
      revokedBy: row.revoked_by,
      revokedReason: row.revoked_reason,
    };
  }
}
