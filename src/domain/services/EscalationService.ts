import {
  EscalationRuleRepository,
  EscalationTicketRepository,
  AlarmRepository,
  DeviceRepository,
  AuditRepository,
} from '../../storage/repositories';
import {
  EscalationRule,
  EscalationRuleStatus,
  EscalationRuleScope,
  EscalationTicket,
  EscalationTicketStatus,
  CreateEscalationRuleInput,
  EscalationFilters,
  PaginatedResult,
  OperationType,
  Alarm,
  AlarmWithEscalation,
  Device,
} from '../../types';
import {
  NotFoundError,
  ConflictError,
  ValidationError,
} from '../../utils/errors';
import {
  getTestUsers,
  checkManageEscalationRulesPermission,
  checkViewEscalationPermission,
  checkClaimEscalationTicketPermission,
  checkExportEscalationPermission,
} from '../rules';
import logger from '../../utils/logger';

export class EscalationService {
  constructor(
    private escalationRuleRepo: EscalationRuleRepository,
    private escalationTicketRepo: EscalationTicketRepository,
    private alarmRepo: AlarmRepository,
    private deviceRepo: DeviceRepository,
    private auditRepo: AuditRepository
  ) {}

  createRule(input: CreateEscalationRuleInput, operator: string): EscalationRule {
    checkManageEscalationRulesPermission(operator);

    this.validateRuleInput(input);

    if (this.escalationRuleRepo.existsActiveForScope(input.scope, input.storeId, input.deviceId)) {
      const scopeDesc = this.getScopeDescription(input.scope, input.storeId, input.deviceId);
      throw new ConflictError(
        `${scopeDesc}已存在生效的升级规则，同一范围内只能有一个生效规则`,
        { scope: input.scope, storeId: input.storeId, deviceId: input.deviceId }
      );
    }

    const rule = this.escalationRuleRepo.create({
      name: input.name,
      scope: input.scope,
      storeId: input.scope === EscalationRuleScope.STORE ? (input.storeId || null) : null,
      deviceId: input.scope === EscalationRuleScope.DEVICE ? (input.deviceId || null) : null,
      acknowledgeTimeoutSeconds: input.acknowledgeTimeoutSeconds,
      assigneeUserId: input.assigneeUserId,
      createdBy: operator,
    });

    this.auditRepo.create({
      operationType: OperationType.ESCALATION_RULE_CREATE,
      entityId: rule.id,
      entityType: 'escalation_rule',
      operator,
      details: `创建升级规则：${rule.name}，范围：${this.getScopeDescription(rule.scope, rule.storeId, rule.deviceId)}，确认时限：${rule.acknowledgeTimeoutSeconds}秒，处理人：${rule.assigneeUserId}`,
    });

    return rule;
  }

  deactivateRule(ruleId: string, operator: string): EscalationRule {
    checkManageEscalationRulesPermission(operator);

    const rule = this.getRule(ruleId);
    if (rule.status !== EscalationRuleStatus.ACTIVE) {
      throw new ConflictError(
        `规则"${ruleId}"当前状态为"${rule.status}"，无法停用`,
        { ruleId, currentStatus: rule.status }
      );
    }

    const now = Date.now();
    const updated = this.escalationRuleRepo.updateStatus(
      ruleId,
      EscalationRuleStatus.INACTIVE,
      {
        deactivatedAt: now,
        deactivatedBy: operator,
      }
    );

    if (!updated) {
      throw new ConflictError(`规则"${ruleId}"停用失败`, { ruleId });
    }

    this.auditRepo.create({
      operationType: OperationType.ESCALATION_RULE_DEACTIVATE,
      entityId: ruleId,
      entityType: 'escalation_rule',
      operator,
      details: `停用升级规则：${rule.name}`,
    });

    return updated;
  }

  revokeRule(ruleId: string, operator: string): EscalationRule {
    checkManageEscalationRulesPermission(operator);

    const rule = this.getRule(ruleId);
    if (rule.status === EscalationRuleStatus.REVOKED) {
      throw new ConflictError(
        `规则"${ruleId}"已被撤销，无需重复操作`,
        { ruleId }
      );
    }

    const now = Date.now();
    const updated = this.escalationRuleRepo.updateStatus(
      ruleId,
      EscalationRuleStatus.REVOKED,
      {
        revokedAt: now,
        revokedBy: operator,
      }
    );

    if (!updated) {
      throw new ConflictError(`规则"${ruleId}"撤销失败`, { ruleId });
    }

    this.auditRepo.create({
      operationType: OperationType.ESCALATION_RULE_REVOKE,
      entityId: ruleId,
      entityType: 'escalation_rule',
      operator,
      details: `撤销升级规则：${rule.name}，历史升级记录保留`,
    });

    return updated;
  }

  getRule(ruleId: string): EscalationRule {
    const rule = this.escalationRuleRepo.findById(ruleId);
    if (!rule) {
      throw new NotFoundError(`升级规则"${ruleId}"不存在`, { ruleId });
    }
    return rule;
  }

  listRules(filters: EscalationFilters = {}, operator: string): PaginatedResult<EscalationRule> {
    checkViewEscalationPermission(operator);
    return this.escalationRuleRepo.findAll(filters);
  }

  getTicket(ticketId: string, operator: string): EscalationTicket {
    checkViewEscalationPermission(operator);
    const ticket = this.escalationTicketRepo.findById(ticketId);
    if (!ticket) {
      throw new NotFoundError(`升级单"${ticketId}"不存在`, { ticketId });
    }
    return ticket;
  }

  listTickets(filters: EscalationFilters = {}, operator: string): PaginatedResult<EscalationTicket> {
    checkViewEscalationPermission(operator);
    return this.escalationTicketRepo.findAll(filters);
  }

  claimTicket(ticketId: string, operator: string): EscalationTicket {
    checkClaimEscalationTicketPermission(operator);

    const ticket = this.escalationTicketRepo.findById(ticketId);
    if (!ticket) {
      throw new NotFoundError(`升级单"${ticketId}"不存在`, { ticketId });
    }

    if (ticket.status !== EscalationTicketStatus.PENDING) {
      throw new ConflictError(
        `升级单"${ticketId}"当前状态为"${ticket.status}"，无法领取`,
        { ticketId, currentStatus: ticket.status }
      );
    }

    const updated = this.escalationTicketRepo.claim(ticketId, operator);
    if (!updated) {
      throw new ConflictError(`升级单"${ticketId}"领取失败，可能已被其他人领取`, { ticketId });
    }

    this.auditRepo.create({
      operationType: OperationType.ESCALATION_TICKET_CLAIM,
      entityId: ticketId,
      entityType: 'escalation_ticket',
      operator,
      details: `领取升级单：${ticketId}，关联告警：${ticket.alarmId}`,
      alarmId: ticket.alarmId,
    });

    return updated;
  }

  getTicketByAlarmId(alarmId: string, operator: string): EscalationTicket | null {
    checkViewEscalationPermission(operator);
    return this.escalationTicketRepo.findByAlarmId(alarmId);
  }

  enrichAlarmWithEscalation(alarm: Alarm): AlarmWithEscalation {
    const ticket = this.escalationTicketRepo.findByAlarmId(alarm.id);
    const enriched: AlarmWithEscalation = { ...alarm };

    if (ticket) {
      const rule = this.escalationRuleRepo.findById(ticket.ruleId);
      enriched.escalationStatus = ticket.status;
      enriched.escalationTicketId = ticket.id;
      enriched.escalationRuleName = rule?.name || null;
      enriched.escalationAssignee = ticket.assigneeUserId;
      enriched.escalationClaimedBy = ticket.claimedBy || null;
      enriched.escalationEscalatedAt = ticket.escalatedAt;
    } else {
      enriched.escalationStatus = null;
      enriched.escalationTicketId = null;
      enriched.escalationRuleName = null;
      enriched.escalationAssignee = null;
      enriched.escalationClaimedBy = null;
      enriched.escalationEscalatedAt = null;
    }

    return enriched;
  }

  enrichAlarmsWithEscalation(alarms: Alarm[]): AlarmWithEscalation[] {
    return alarms.map(alarm => this.enrichAlarmWithEscalation(alarm));
  }

  processOverdueAlarms(currentTime?: number, operator?: string): number {
    if (operator) {
      checkManageEscalationRulesPermission(operator);
    }
    const now = currentTime || Date.now();
    const overdueAlarms = this.escalationTicketRepo.findOverdueAlarms(now);
    let createdCount = 0;

    for (const overdue of overdueAlarms) {
      if (!overdue.ruleId || !overdue.assigneeUserId) {
        continue;
      }

      try {
        const existingTicket = this.escalationTicketRepo.findByAlarmId(overdue.alarmId);
        if (existingTicket) {
          continue;
        }

        const ticket = this.escalationTicketRepo.create({
          alarmId: overdue.alarmId,
          ruleId: overdue.ruleId,
          assigneeUserId: overdue.assigneeUserId,
          escalatedAt: now,
        });

        this.auditRepo.create({
          operationType: OperationType.ESCALATION_TICKET_CREATE,
          entityId: ticket.id,
          entityType: 'escalation_ticket',
          operator: 'system',
          details: `告警超时自动升级：告警${overdue.alarmId}超过确认时限${overdue.acknowledgeTimeoutSeconds}秒，升级单已派发给${overdue.assigneeUserId}`,
          alarmId: overdue.alarmId,
          deviceId: overdue.deviceId,
          storeId: overdue.storeId,
        });

        createdCount++;
        logger.info(`Created escalation ticket ${ticket.id} for alarm ${overdue.alarmId}`);
      } catch (error) {
        logger.error(`Failed to create escalation ticket for alarm ${overdue.alarmId}`, error);
      }
    }

    return createdCount;
  }

  getTicketStats(operator: string) {
    checkViewEscalationPermission(operator);
    return {
      pending: this.escalationTicketRepo.countByStatus(EscalationTicketStatus.PENDING),
      claimed: this.escalationTicketRepo.countByStatus(EscalationTicketStatus.CLAIMED),
      resolved: this.escalationTicketRepo.countByStatus(EscalationTicketStatus.RESOLVED),
    };
  }

  exportToCsv(filters: EscalationFilters = {}, operator: string): string {
    checkExportEscalationPermission(operator);

    const tickets = this.escalationTicketRepo.findAllForExport(filters);
    const enrichedTickets = tickets.map(ticket => {
      const rule = this.escalationRuleRepo.findById(ticket.ruleId);
      const alarm = this.alarmRepo.findById(ticket.alarmId);
      const device = alarm ? this.deviceRepo.findById(alarm.deviceId) : null;
      return { ticket, rule, alarm, device };
    });

    const headers = [
      '升级单ID', '告警ID', '规则名称', '状态', '指派处理人',
      '领取人', '升级时间', '领取时间', '解决时间', '解决备注',
      '设备ID', '设备名称', '门店ID', '门店名称',
      '告警类型', '告警温度', '告警阈值', '创建时间'
    ];

    const rows = enrichedTickets.map(({ ticket, rule, alarm, device }) => [
      ticket.id,
      ticket.alarmId,
      `"${(rule?.name || '').replace(/"/g, '""')}"`,
      this.getTicketStatusText(ticket.status),
      ticket.assigneeUserId,
      ticket.claimedBy || '',
      ticket.escalatedAt ? new Date(ticket.escalatedAt).toLocaleString('zh-CN') : '',
      ticket.claimedAt ? new Date(ticket.claimedAt).toLocaleString('zh-CN') : '',
      ticket.resolvedAt ? new Date(ticket.resolvedAt).toLocaleString('zh-CN') : '',
      `"${(ticket.resolutionNote || '').replace(/"/g, '""')}"`,
      alarm?.deviceId || '',
      device?.name || '',
      device?.storeId || '',
      device?.storeName || '',
      alarm?.type || '',
      alarm?.temperature || '',
      alarm?.threshold || '',
      alarm ? new Date(alarm.createdAt).toLocaleString('zh-CN') : '',
    ]);

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  exportToJson(filters: EscalationFilters = {}, operator: string): string {
    checkExportEscalationPermission(operator);

    const tickets = this.escalationTicketRepo.findAllForExport(filters);
    const enriched = tickets.map(ticket => {
      const rule = this.escalationRuleRepo.findById(ticket.ruleId);
      const alarm = this.alarmRepo.findById(ticket.alarmId);
      const device = alarm ? this.deviceRepo.findById(alarm.deviceId) : null;
      return {
        ticket,
        ruleName: rule?.name,
        ruleScope: rule?.scope,
        alarm,
        device,
      };
    });

    return JSON.stringify(enriched, null, 2);
  }

  export(
    filters: EscalationFilters & { format?: 'csv' | 'json' },
    operator: string
  ): { content: string; contentType: string; filename: string } {
    const format = filters.format || 'csv';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (format === 'json') {
      return {
        content: this.exportToJson(filters, operator),
        contentType: 'application/json; charset=utf-8',
        filename: `escalation_tickets_${timestamp}.json`,
      };
    }

    return {
      content: this.exportToCsv(filters, operator),
      contentType: 'text/csv; charset=utf-8',
      filename: `escalation_tickets_${timestamp}.csv`,
    };
  }

  private validateRuleInput(input: CreateEscalationRuleInput): void {
    if (!input.name || input.name.trim().length === 0) {
      throw new ValidationError('规则名称不能为空', 'name');
    }

    if (input.acknowledgeTimeoutSeconds <= 0) {
      throw new ValidationError(
        '确认时限必须大于0秒',
        'acknowledgeTimeoutSeconds',
        { value: input.acknowledgeTimeoutSeconds }
      );
    }

    const validUsers = getTestUsers().map(u => u.id);
    if (!validUsers.includes(input.assigneeUserId)) {
      throw new ValidationError(
        `处理人"${input.assigneeUserId}"不存在，有效的处理人包括：${validUsers.join(', ')}`,
        'assigneeUserId',
        { value: input.assigneeUserId, validUsers }
      );
    }

    if (input.scope === EscalationRuleScope.STORE) {
      if (!input.storeId) {
        throw new ValidationError('门店范围必须指定门店ID', 'storeId');
      }
    }

    if (input.scope === EscalationRuleScope.DEVICE) {
      if (!input.deviceId) {
        throw new ValidationError('设备范围必须指定设备ID', 'deviceId');
      }

      const device = this.deviceRepo.findById(input.deviceId);
      if (!device) {
        throw new ValidationError(
          `设备"${input.deviceId}"不存在`,
          'deviceId',
          { deviceId: input.deviceId }
        );
      }

      if (device.status !== 'active') {
        throw new ValidationError(
          `设备"${input.deviceId}"已停用，不能创建升级规则`,
          'deviceId',
          { deviceId: input.deviceId, deviceStatus: device.status }
        );
      }
    }
  }

  private getScopeDescription(scope: EscalationRuleScope, storeId?: string | null, deviceId?: string | null): string {
    switch (scope) {
      case EscalationRuleScope.DEFAULT:
        return '默认范围';
      case EscalationRuleScope.STORE:
        return `门店(${storeId})`;
      case EscalationRuleScope.DEVICE:
        return `设备(${deviceId})`;
      default:
        return scope;
    }
  }

  private getTicketStatusText(status: EscalationTicketStatus): string {
    switch (status) {
      case EscalationTicketStatus.PENDING:
        return '待领取';
      case EscalationTicketStatus.CLAIMED:
        return '已领取';
      case EscalationTicketStatus.RESOLVED:
        return '已解决';
      default:
        return status;
    }
  }
}
