import { prepare, saveDatabase } from '../database';
import { CalibrationPlan, CalibrationPlanStatus, CalibrationFilters, PaginatedResult } from '../../types';
import crypto from 'crypto';

export class CalibrationPlanRepository {

  create(plan: Omit<CalibrationPlan, 'id' | 'createdAt' | 'updatedAt' | 'status'>): CalibrationPlan {
    const id = `cp-${crypto.randomUUID()}`;
    const now = Date.now();
    const stmt = prepare(`
      INSERT INTO calibration_plans (
        id, device_id, store_id, offset_value, effective_start_time,
        effective_end_time, reason, person_in_charge, status,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      plan.deviceId,
      plan.storeId,
      plan.offsetValue,
      plan.effectiveStartTime,
      plan.effectiveEndTime,
      plan.reason,
      plan.personInCharge,
      CalibrationPlanStatus.ACTIVE,
      plan.createdBy,
      now,
      now
    );
    saveDatabase();
    return {
      ...plan,
      id,
      status: CalibrationPlanStatus.ACTIVE,
      createdAt: now,
      updatedAt: now
    };
  }

  findById(id: string): CalibrationPlan | null {
    const row = prepare('SELECT * FROM calibration_plans WHERE id = ?').get(id) as any;
    return row ? this.mapToPlan(row) : null;
  }

  findAll(filters: CalibrationFilters = {}): PaginatedResult<CalibrationPlan> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.planStatus) {
      conditions.push('status = ?');
      params.push(filters.planStatus);
    }
    if (filters.deviceId) {
      conditions.push('device_id = ?');
      params.push(filters.deviceId);
    }
    if (filters.storeId) {
      conditions.push('store_id = ?');
      params.push(filters.storeId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countStmt = prepare(`SELECT COUNT(*) as count FROM calibration_plans ${whereClause}`);
    const total = (countStmt.get(...params) as { count: number }).count;

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 50;
    const offset = (page - 1) * pageSize;

    const rows = prepare(`
      SELECT * FROM calibration_plans ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[];

    return {
      items: rows.map(this.mapToPlan),
      total,
      page,
      pageSize,
    };
  }

  findActiveForDeviceAtTime(deviceId: string, timestamp: number): CalibrationPlan | null {
    const rows = prepare(`
      SELECT * FROM calibration_plans
      WHERE device_id = ?
        AND status = ?
        AND effective_start_time <= ?
        AND (effective_end_time IS NULL OR effective_end_time >= ?)
      ORDER BY effective_start_time DESC
      LIMIT 1
    `).all(deviceId, CalibrationPlanStatus.ACTIVE, timestamp, timestamp) as any[];

    return rows.length > 0 ? this.mapToPlan(rows[0]) : null;
  }

  findOverlappingPlans(
    deviceId: string,
    startTime: number,
    endTime: number | null,
    excludePlanId?: string
  ): CalibrationPlan[] {
    const conditions: string[] = [
      'device_id = ?',
      'status = ?',
      `(
        (effective_end_time IS NULL AND ? >= effective_start_time)
        OR
        (? >= effective_start_time AND (effective_end_time IS NULL OR ? <= effective_end_time))
        OR
        (? IS NOT NULL AND ? >= effective_start_time AND (effective_end_time IS NULL OR ? <= effective_end_time))
      )`
    ];
    const params: any[] = [deviceId, CalibrationPlanStatus.ACTIVE, startTime, startTime, startTime, endTime, endTime, endTime];

    if (excludePlanId) {
      conditions.push('id != ?');
      params.push(excludePlanId);
    }

    const whereClause = conditions.join(' AND ');
    const rows = prepare(`
      SELECT * FROM calibration_plans
      WHERE ${whereClause}
      ORDER BY effective_start_time ASC
    `).all(...params) as any[];

    return rows.map(this.mapToPlan);
  }

  existsActiveForDeviceAtTime(deviceId: string, startTime: number, endTime: number | null, excludePlanId?: string): boolean {
    const overlapping = this.findOverlappingPlans(deviceId, startTime, endTime, excludePlanId);
    return overlapping.length > 0;
  }

  updateStatus(id: string, status: CalibrationPlanStatus, updates: Partial<CalibrationPlan> = {}): CalibrationPlan | null {
    const fields: string[] = ['status = ?', 'updated_at = ?'];
    const params: any[] = [status, Date.now()];

    if (updates.deactivatedAt !== undefined) { fields.push('deactivated_at = ?'); params.push(updates.deactivatedAt); }
    if (updates.deactivatedBy !== undefined) { fields.push('deactivated_by = ?'); params.push(updates.deactivatedBy); }
    if (updates.revokedAt !== undefined) { fields.push('revoked_at = ?'); params.push(updates.revokedAt); }
    if (updates.revokedBy !== undefined) { fields.push('revoked_by = ?'); params.push(updates.revokedBy); }

    params.push(id);

    const stmt = prepare(`UPDATE calibration_plans SET ${fields.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);
    if (result.changes === 0) return null;
    saveDatabase();
    return this.findById(id);
  }

  private mapToPlan(row: any): CalibrationPlan {
    return {
      id: row.id,
      deviceId: row.device_id,
      storeId: row.store_id,
      offsetValue: row.offset_value,
      effectiveStartTime: row.effective_start_time,
      effectiveEndTime: row.effective_end_time,
      reason: row.reason,
      personInCharge: row.person_in_charge,
      status: row.status as CalibrationPlanStatus,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deactivatedAt: row.deactivated_at,
      deactivatedBy: row.deactivated_by,
      revokedAt: row.revoked_at,
      revokedBy: row.revoked_by,
    };
  }
}
