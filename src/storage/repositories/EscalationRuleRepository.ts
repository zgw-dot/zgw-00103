import { prepare, saveDatabase } from '../database';
import { EscalationRule, EscalationRuleStatus, EscalationRuleScope, EscalationFilters, PaginatedResult } from '../../types';
import crypto from 'crypto';

export class EscalationRuleRepository {

  create(rule: Omit<EscalationRule, 'id' | 'createdAt' | 'updatedAt' | 'status'>): EscalationRule {
    const id = `er-${crypto.randomUUID()}`;
    const now = Date.now();
    const stmt = prepare(`
      INSERT INTO escalation_rules (
        id, name, scope, store_id, device_id, acknowledge_timeout_seconds,
        assignee_user_id, status, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      rule.name,
      rule.scope,
      rule.storeId,
      rule.deviceId,
      rule.acknowledgeTimeoutSeconds,
      rule.assigneeUserId,
      EscalationRuleStatus.ACTIVE,
      rule.createdBy,
      now,
      now
    );
    saveDatabase();
    return {
      ...rule,
      id,
      status: EscalationRuleStatus.ACTIVE,
      createdAt: now,
      updatedAt: now
    };
  }

  findById(id: string): EscalationRule | null {
    const row = prepare('SELECT * FROM escalation_rules WHERE id = ?').get(id) as any;
    return row ? this.mapToRule(row) : null;
  }

  findAll(filters: EscalationFilters = {}): PaginatedResult<EscalationRule> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.ruleStatus) {
      conditions.push('status = ?');
      params.push(filters.ruleStatus);
    }
    if (filters.storeId) {
      conditions.push('store_id = ?');
      params.push(filters.storeId);
    }
    if (filters.deviceId) {
      conditions.push('device_id = ?');
      params.push(filters.deviceId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countStmt = prepare(`SELECT COUNT(*) as count FROM escalation_rules ${whereClause}`);
    const total = (countStmt.get(...params) as { count: number }).count;

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 50;
    const offset = (page - 1) * pageSize;

    const rows = prepare(`
      SELECT * FROM escalation_rules ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[];

    return {
      items: rows.map(this.mapToRule),
      total,
      page,
      pageSize,
    };
  }

  findActiveDefaultRule(): EscalationRule | null {
    const row = prepare(`
      SELECT * FROM escalation_rules
      WHERE scope = ? AND status = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(EscalationRuleScope.DEFAULT, EscalationRuleStatus.ACTIVE) as any;
    return row ? this.mapToRule(row) : null;
  }

  findActiveStoreRule(storeId: string): EscalationRule | null {
    const row = prepare(`
      SELECT * FROM escalation_rules
      WHERE scope = ? AND store_id = ? AND status = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(EscalationRuleScope.STORE, storeId, EscalationRuleStatus.ACTIVE) as any;
    return row ? this.mapToRule(row) : null;
  }

  findActiveDeviceRule(deviceId: string): EscalationRule | null {
    const row = prepare(`
      SELECT * FROM escalation_rules
      WHERE scope = ? AND device_id = ? AND status = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(EscalationRuleScope.DEVICE, deviceId, EscalationRuleStatus.ACTIVE) as any;
    return row ? this.mapToRule(row) : null;
  }

  existsActiveForScope(scope: EscalationRuleScope, storeId?: string, deviceId?: string, excludeRuleId?: string): boolean {
    const conditions: string[] = ['scope = ?', 'status = ?'];
    const params: any[] = [scope, EscalationRuleStatus.ACTIVE];

    if (scope === EscalationRuleScope.STORE && storeId) {
      conditions.push('store_id = ?');
      params.push(storeId);
    }
    if (scope === EscalationRuleScope.DEVICE && deviceId) {
      conditions.push('device_id = ?');
      params.push(deviceId);
    }
    if (excludeRuleId) {
      conditions.push('id != ?');
      params.push(excludeRuleId);
    }

    const row = prepare(`
      SELECT 1 FROM escalation_rules
      WHERE ${conditions.join(' AND ')}
      LIMIT 1
    `).get(...params);
    return !!row;
  }

  updateStatus(id: string, status: EscalationRuleStatus, updates: Partial<EscalationRule> = {}): EscalationRule | null {
    const fields: string[] = ['status = ?', 'updated_at = ?'];
    const params: any[] = [status, Date.now()];

    if (updates.deactivatedAt !== undefined) { fields.push('deactivated_at = ?'); params.push(updates.deactivatedAt); }
    if (updates.deactivatedBy !== undefined) { fields.push('deactivated_by = ?'); params.push(updates.deactivatedBy); }
    if (updates.revokedAt !== undefined) { fields.push('revoked_at = ?'); params.push(updates.revokedAt); }
    if (updates.revokedBy !== undefined) { fields.push('revoked_by = ?'); params.push(updates.revokedBy); }

    params.push(id);

    const stmt = prepare(`UPDATE escalation_rules SET ${fields.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);
    if (result.changes === 0) return null;
    saveDatabase();
    return this.findById(id);
  }

  private mapToRule(row: any): EscalationRule {
    return {
      id: row.id,
      name: row.name,
      scope: row.scope as EscalationRuleScope,
      storeId: row.store_id,
      deviceId: row.device_id,
      acknowledgeTimeoutSeconds: row.acknowledge_timeout_seconds,
      assigneeUserId: row.assignee_user_id,
      status: row.status as EscalationRuleStatus,
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
