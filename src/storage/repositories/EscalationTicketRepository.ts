import { prepare, saveDatabase } from '../database';
import { EscalationTicket, EscalationTicketStatus, EscalationFilters, PaginatedResult } from '../../types';
import crypto from 'crypto';

export class EscalationTicketRepository {

  create(ticket: Omit<EscalationTicket, 'id' | 'createdAt' | 'updatedAt' | 'status'>): EscalationTicket {
    const id = `et-${crypto.randomUUID()}`;
    const now = Date.now();
    const stmt = prepare(`
      INSERT INTO escalation_tickets (
        id, alarm_id, rule_id, status, assignee_user_id, escalated_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      ticket.alarmId,
      ticket.ruleId,
      EscalationTicketStatus.PENDING,
      ticket.assigneeUserId,
      ticket.escalatedAt,
      now,
      now
    );
    saveDatabase();
    return {
      ...ticket,
      id,
      status: EscalationTicketStatus.PENDING,
      createdAt: now,
      updatedAt: now
    };
  }

  findById(id: string): EscalationTicket | null {
    const row = prepare('SELECT * FROM escalation_tickets WHERE id = ?').get(id) as any;
    return row ? this.mapToTicket(row) : null;
  }

  findByAlarmId(alarmId: string): EscalationTicket | null {
    const row = prepare('SELECT * FROM escalation_tickets WHERE alarm_id = ?').get(alarmId) as any;
    return row ? this.mapToTicket(row) : null;
  }

  findAll(filters: EscalationFilters = {}): PaginatedResult<EscalationTicket> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.ticketStatus) {
      conditions.push('status = ?');
      params.push(filters.ticketStatus);
    }
    if (filters.assigneeUserId) {
      conditions.push('assignee_user_id = ?');
      params.push(filters.assigneeUserId);
    }
    if (filters.claimedBy) {
      conditions.push('claimed_by = ?');
      params.push(filters.claimedBy);
    }
    if (filters.ruleId) {
      conditions.push('rule_id = ?');
      params.push(filters.ruleId);
    }
    if (filters.alarmId) {
      conditions.push('alarm_id = ?');
      params.push(filters.alarmId);
    }
    if (filters.startTime) {
      conditions.push('escalated_at >= ?');
      params.push(filters.startTime);
    }
    if (filters.endTime) {
      conditions.push('escalated_at <= ?');
      params.push(filters.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countStmt = prepare(`SELECT COUNT(*) as count FROM escalation_tickets ${whereClause}`);
    const total = (countStmt.get(...params) as { count: number }).count;

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 50;
    const offset = (page - 1) * pageSize;

    const rows = prepare(`
      SELECT * FROM escalation_tickets ${whereClause}
      ORDER BY escalated_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[];

    return {
      items: rows.map(this.mapToTicket),
      total,
      page,
      pageSize,
    };
  }

  findAllForExport(filters: EscalationFilters = {}): EscalationTicket[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.ticketStatus) {
      conditions.push('status = ?');
      params.push(filters.ticketStatus);
    }
    if (filters.assigneeUserId) {
      conditions.push('assignee_user_id = ?');
      params.push(filters.assigneeUserId);
    }
    if (filters.claimedBy) {
      conditions.push('claimed_by = ?');
      params.push(filters.claimedBy);
    }
    if (filters.ruleId) {
      conditions.push('rule_id = ?');
      params.push(filters.ruleId);
    }
    if (filters.alarmId) {
      conditions.push('alarm_id = ?');
      params.push(filters.alarmId);
    }
    if (filters.startTime) {
      conditions.push('escalated_at >= ?');
      params.push(filters.startTime);
    }
    if (filters.endTime) {
      conditions.push('escalated_at <= ?');
      params.push(filters.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = prepare(`
      SELECT * FROM escalation_tickets ${whereClause}
      ORDER BY escalated_at DESC
    `).all(...params) as any[];

    return rows.map(this.mapToTicket);
  }

  findOverdueAlarms(currentTime: number): Array<{
    alarmId: string;
    deviceId: string;
    storeId: string;
    createdAt: number;
    ruleId?: string;
    acknowledgeTimeoutSeconds?: number;
    assigneeUserId?: string;
  }> {
    const sql = `
      SELECT
        a.id as alarm_id,
        a.device_id,
        d.store_id,
        a.created_at,
        COALESCE(er_device.id, er_store.id, er_default.id) as rule_id,
        COALESCE(er_device.acknowledge_timeout_seconds, er_store.acknowledge_timeout_seconds, er_default.acknowledge_timeout_seconds) as acknowledge_timeout_seconds,
        COALESCE(er_device.assignee_user_id, er_store.assignee_user_id, er_default.assignee_user_id) as assignee_user_id
      FROM alarms a
      INNER JOIN devices d ON a.device_id = d.id
      LEFT JOIN escalation_rules er_device ON
        er_device.scope = 'device' AND
        er_device.device_id = a.device_id AND
        er_device.status = 'active'
      LEFT JOIN escalation_rules er_store ON
        er_store.scope = 'store' AND
        er_store.store_id = d.store_id AND
        er_store.status = 'active'
      LEFT JOIN escalation_rules er_default ON
        er_default.scope = 'default' AND
        er_default.status = 'active'
      LEFT JOIN escalation_tickets et ON a.id = et.alarm_id
      WHERE
        a.status = 'open' AND
        a.acknowledged_at IS NULL AND
        et.id IS NULL AND
        d.status = 'active' AND
        (
          (er_device.id IS NOT NULL AND a.created_at + (er_device.acknowledge_timeout_seconds * 1000) <= ?) OR
          (er_device.id IS NULL AND er_store.id IS NOT NULL AND a.created_at + (er_store.acknowledge_timeout_seconds * 1000) <= ?) OR
          (er_device.id IS NULL AND er_store.id IS NULL AND er_default.id IS NOT NULL AND a.created_at + (er_default.acknowledge_timeout_seconds * 1000) <= ?)
        )
    `;

    const rows = prepare(sql).all(currentTime, currentTime, currentTime) as any[];
    return rows.map(row => ({
      alarmId: row.alarm_id,
      deviceId: row.device_id,
      storeId: row.store_id,
      createdAt: row.created_at,
      ruleId: row.rule_id,
      acknowledgeTimeoutSeconds: row.acknowledge_timeout_seconds,
      assigneeUserId: row.assignee_user_id,
    }));
  }

  claim(id: string, claimedBy: string): EscalationTicket | null {
    const now = Date.now();
    const stmt = prepare(`
      UPDATE escalation_tickets
      SET status = ?, claimed_by = ?, claimed_at = ?, updated_at = ?
      WHERE id = ? AND status = ?
    `);
    const result = stmt.run(
      EscalationTicketStatus.CLAIMED,
      claimedBy,
      now,
      now,
      id,
      EscalationTicketStatus.PENDING
    );
    if (result.changes === 0) return null;
    saveDatabase();
    return this.findById(id);
  }

  resolve(id: string, resolvedBy: string, resolutionNote: string): EscalationTicket | null {
    const now = Date.now();
    const stmt = prepare(`
      UPDATE escalation_tickets
      SET status = ?, resolved_by = ?, resolution_note = ?, resolved_at = ?, updated_at = ?
      WHERE id = ? AND status IN (?, ?)
    `);
    const result = stmt.run(
      EscalationTicketStatus.RESOLVED,
      resolvedBy,
      resolutionNote,
      now,
      now,
      id,
      EscalationTicketStatus.PENDING,
      EscalationTicketStatus.CLAIMED
    );
    if (result.changes === 0) return null;
    saveDatabase();
    return this.findById(id);
  }

  countByStatus(status: EscalationTicketStatus): number {
    const row = prepare('SELECT COUNT(*) as count FROM escalation_tickets WHERE status = ?').get(status) as { count: number };
    return row.count;
  }

  private mapToTicket(row: any): EscalationTicket {
    return {
      id: row.id,
      alarmId: row.alarm_id,
      ruleId: row.rule_id,
      status: row.status as EscalationTicketStatus,
      assigneeUserId: row.assignee_user_id,
      claimedBy: row.claimed_by,
      claimedAt: row.claimed_at,
      escalatedAt: row.escalated_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
      resolutionNote: row.resolution_note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
