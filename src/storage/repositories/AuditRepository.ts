import { prepare, runInTransaction, saveDatabase } from '../database';
import { AuditLog, QueryFilters, PaginatedResult } from '../../types';
import crypto from 'crypto';

export class AuditRepository {

  create(log: Omit<AuditLog, 'id' | 'createdAt'>): AuditLog {
    const id = `audit-${crypto.randomUUID()}`;
    const now = Date.now();
    const stmt = prepare(`
      INSERT INTO audit_logs (
        id, operation_type, entity_id, entity_type, operator, details,
        store_id, device_id, import_batch_id, alarm_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      log.operationType,
      log.entityId,
      log.entityType,
      log.operator,
      log.details,
      log.storeId || null,
      log.deviceId || null,
      log.importBatchId || null,
      log.alarmId || null,
      now
    );
    saveDatabase();
    return { ...log, id, createdAt: now };
  }

  findAll(filters: QueryFilters = {}): PaginatedResult<AuditLog> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.storeId) {
      conditions.push('store_id = ?');
      params.push(filters.storeId);
    }
    if (filters.deviceId) {
      conditions.push('device_id = ?');
      params.push(filters.deviceId);
    }
    if (filters.importBatchId) {
      conditions.push('import_batch_id = ?');
      params.push(filters.importBatchId);
    }
    if (filters.alarmStatus) {
      conditions.push(`alarm_id IN (SELECT id FROM alarms WHERE status = ?)`);
      params.push(filters.alarmStatus);
    }
    if (filters.startTime) {
      conditions.push('created_at >= ?');
      params.push(filters.startTime);
    }
    if (filters.endTime) {
      conditions.push('created_at <= ?');
      params.push(filters.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countStmt = prepare(`SELECT COUNT(*) as count FROM audit_logs ${whereClause}`);
    const total = (countStmt.get(...params) as { count: number }).count;

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 100;
    const offset = (page - 1) * pageSize;

    const rows = prepare(`
      SELECT * FROM audit_logs ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[];

    return {
      items: rows.map(this.mapToAuditLog),
      total,
      page,
      pageSize,
    };
  }

  findAllForExport(filters: QueryFilters = {}): AuditLog[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.storeId) {
      conditions.push('store_id = ?');
      params.push(filters.storeId);
    }
    if (filters.deviceId) {
      conditions.push('device_id = ?');
      params.push(filters.deviceId);
    }
    if (filters.importBatchId) {
      conditions.push('import_batch_id = ?');
      params.push(filters.importBatchId);
    }
    if (filters.alarmStatus) {
      conditions.push(`alarm_id IN (SELECT id FROM alarms WHERE status = ?)`);
      params.push(filters.alarmStatus);
    }
    if (filters.startTime) {
      conditions.push('created_at >= ?');
      params.push(filters.startTime);
    }
    if (filters.endTime) {
      conditions.push('created_at <= ?');
      params.push(filters.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = prepare(`
      SELECT * FROM audit_logs ${whereClause}
      ORDER BY created_at DESC
    `).all(...params) as any[];

    return rows.map(this.mapToAuditLog);
  }

  private mapToAuditLog(row: any): AuditLog {
    return {
      id: row.id,
      operationType: row.operation_type,
      entityId: row.entity_id,
      entityType: row.entity_type,
      operator: row.operator,
      details: row.details,
      storeId: row.store_id,
      deviceId: row.device_id,
      importBatchId: row.import_batch_id,
      alarmId: row.alarm_id,
      createdAt: row.created_at,
    };
  }
}
