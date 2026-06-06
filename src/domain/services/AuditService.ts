import { AuditRepository } from '../../storage/repositories';
import { AuditLog, QueryFilters, PaginatedResult } from '../../types';
import { checkExportPermission } from '../rules';

export class AuditService {
  constructor(private auditRepo: AuditRepository) {}

  listAuditLogs(filters: QueryFilters = {}): PaginatedResult<AuditLog> {
    return this.auditRepo.findAll(filters);
  }

  exportToCsv(filters: QueryFilters = {}, operator: string): string {
    checkExportPermission(operator);

    const logs = this.auditRepo.findAllForExport(filters);
    const headers = ['ID', '操作类型', '实体ID', '实体类型', '操作人', '详情', '门店ID', '设备ID', '导入批次ID', '告警ID', '操作时间'];
    const rows = logs.map(log => [
      log.id || '',
      log.operationType,
      log.entityId,
      log.entityType,
      log.operator,
      `"${(log.details || '').replace(/"/g, '""')}"`,
      log.storeId || '',
      log.deviceId || '',
      log.importBatchId || '',
      log.alarmId || '',
      new Date(log.createdAt).toLocaleString('zh-CN'),
    ]);

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  exportToJson(filters: QueryFilters = {}, operator: string): string {
    checkExportPermission(operator);

    const logs = this.auditRepo.findAllForExport(filters);
    return JSON.stringify(logs, null, 2);
  }

  export(filters: QueryFilters & { format?: 'csv' | 'json' }, operator: string): { content: string; contentType: string; filename: string } {
    const format = filters.format || 'csv';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (format === 'json') {
      return {
        content: this.exportToJson(filters, operator),
        contentType: 'application/json; charset=utf-8',
        filename: `audit_logs_${timestamp}.json`,
      };
    }

    return {
      content: this.exportToCsv(filters, operator),
      contentType: 'text/csv; charset=utf-8',
      filename: `audit_logs_${timestamp}.csv`,
    };
  }
}
