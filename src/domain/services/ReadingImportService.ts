import { Readable } from 'stream';
import csvParser from 'csv-parser';
import { runInTransaction } from '../../storage/database';
import {
  DeviceRepository,
  ReadingRepository,
  ImportBatchRepository,
  AuditRepository,
  ThresholdRepository,
  AlarmRepository,
  BatchRowResultRepository,
} from '../../storage/repositories';
import { AlarmService } from './AlarmService';
import {
  CsvReadingRow,
  ImportResult,
  OperationType,
  TemperatureReading,
  DryRunResult,
  BatchStatus,
  RowStatus,
  BatchRowResult,
  BatchDetail,
  PaginatedBatchDetail,
  BatchDetailFilters,
  ImportBatch,
  Alarm,
  AuditLog,
  Threshold,
  QueryFilters,
} from '../../types';
import {
  validateImportRow,
  RowValidationContext,
  checkImportPermission,
  checkDryRunPermission,
  checkViewBatchesPermission,
  checkExportBatchesPermission,
  performDryRun,
  preCheckAndClassifyRow,
  PreCheckContext,
} from '../rules';
import logger from '../../utils/logger';
import { NotFoundError, BusinessError } from '../../utils/errors';

const EXPORT_ROW_FIELDS: Array<keyof BatchRowResult> = [
  'rowIndex',
  'deviceId',
  'temperature',
  'readingTime',
  'status',
  'errorMessage',
  'importBatchId',
  'id',
  'createdAt',
];

const EXPORT_ALARM_FIELDS: Array<keyof Alarm> = [
  'id',
  'deviceId',
  'type',
  'threshold',
  'temperature',
  'readingTime',
  'status',
  'readingId',
  'acknowledgedAt',
  'acknowledgedBy',
  'recoveredAt',
  'recoveredReadingId',
  'recoveredTemperature',
  'closedAt',
  'closedBy',
  'closeNote',
  'createdAt',
  'updatedAt',
];

const EXPORT_AUDIT_FIELDS: Array<keyof AuditLog> = [
  'operationType',
  'operator',
  'details',
  'createdAt',
  'entityId',
  'entityType',
  'storeId',
  'deviceId',
  'importBatchId',
  'alarmId',
  'id',
];

const EXPORT_BATCH_FIELDS: Array<keyof ImportBatch> = [
  'id',
  'fileName',
  'status',
  'createdBy',
  'createdAt',
  'completedAt',
  'totalCount',
  'successCount',
  'failedCount',
  'errorDetails',
];

function formatValue(value: any): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function formatExportRow<T>(obj: T, fields: Array<keyof T>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const field of fields) {
    const value = obj[field];
    result[field as string] = value === undefined ? null : value;
  }
  return result;
}

function exportToCsvLine(values: any[]): string {
  return values.map(v => {
    const formatted = formatValue(v);
    if (formatted.includes(',') || formatted.includes('"') || formatted.includes('\n')) {
      return `"${formatted.replace(/"/g, '""')}"`;
    }
    return formatted;
  }).join(',');
}

export class ReadingImportService {

  constructor(
    private deviceRepo: DeviceRepository,
    private readingRepo: ReadingRepository,
    private importBatchRepo: ImportBatchRepository,
    private batchRowResultRepo: BatchRowResultRepository,
    private auditRepo: AuditRepository,
    private alarmService: AlarmService,
    private thresholdRepo: ThresholdRepository,
    private alarmRepo: AlarmRepository
  ) {}

  private async parseCsvWithAutoHeaderDetection(fileStream: Readable): Promise<CsvReadingRow[]> {
    const rawLines: string[] = [];

    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      fileStream
        .on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          rawLines.push(...lines);
        })
        .on('end', () => {
          if (buffer.trim()) rawLines.push(buffer);
          resolve();
        })
        .on('error', reject);
    });

    const rows: CsvReadingRow[] = [];
    let startIndex = 0;

    if (rawLines.length > 0) {
      const firstLine = rawLines[0].trim().toLowerCase();
      if (firstLine.includes('deviceid') && firstLine.includes('temperature') && firstLine.includes('readingtime')) {
        startIndex = 1;
      }
    }

    for (let i = startIndex; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (!line) continue;

      const values = line.split(',');
      const deviceId = values[0]?.trim() || '';
      const temperature = values[1]?.trim() || '';
      const readingTime = values[2]?.trim() || '';

      rows.push({ deviceId, temperature, readingTime });
    }

    return rows;
  }

  async dryRunImport(
    fileStream: Readable,
    fileName: string,
    operator: string
  ): Promise<DryRunResult> {
    checkDryRunPermission(operator);

    const rows = await this.parseCsvWithAutoHeaderDetection(fileStream);

    return performDryRun(
      rows,
      fileName,
      this.deviceRepo,
      this.readingRepo,
      this.thresholdRepo,
      this.alarmRepo
    );
  }

  async importFromCsv(
    fileStream: Readable,
    fileName: string,
    operator: string
  ): Promise<ImportResult> {
    checkImportPermission(operator);

    const rows = await this.parseCsvWithAutoHeaderDetection(fileStream);

    const dryRunResult = await performDryRun(
      rows,
      fileName,
      this.deviceRepo,
      this.readingRepo,
      this.thresholdRepo,
      this.alarmRepo
    );

    if (dryRunResult.invalidCount > 0) {
      const seenRows = new Set<number>();
      const allErrors: string[] = [];
      
      for (const e of dryRunResult.rowErrors) {
        if (!seenRows.has(e.rowIndex)) {
          seenRows.add(e.rowIndex);
          allErrors.push(e.error);
        }
      }
      
      for (const d of dryRunResult.unknownDevices) {
        if (!seenRows.has(d.rowIndex)) {
          seenRows.add(d.rowIndex);
          allErrors.push(`第${d.rowIndex}行：设备"${d.deviceId}"不存在`);
        }
      }
      
      for (const d of dryRunResult.inactiveDevices) {
        if (!seenRows.has(d.rowIndex)) {
          seenRows.add(d.rowIndex);
          allErrors.push(`第${d.rowIndex}行：设备"${d.deviceId}"已停用`);
        }
      }
      
      for (const d of dryRunResult.duplicateTimes) {
        if (!seenRows.has(d.rowIndex)) {
          seenRows.add(d.rowIndex);
          allErrors.push(`第${d.rowIndex}行：设备"${d.deviceId}"在时间戳${d.readingTime}存在重复读数`);
        }
      }
      
      for (const d of dryRunResult.outOfOrderTimes) {
        if (!seenRows.has(d.rowIndex)) {
          seenRows.add(d.rowIndex);
          allErrors.push(`第${d.rowIndex}行：设备"${d.deviceId}"读数时间倒序`);
        }
      }
      
      for (const d of dryRunResult.thresholdConflicts) {
        if (!seenRows.has(d.rowIndex)) {
          seenRows.add(d.rowIndex);
          allErrors.push(`第${d.rowIndex}行：设备"${d.deviceId}"温度${d.temperature}${d.violationType === 'above_max' ? '高于' : '低于'}阈值${d.violationType === 'above_max' ? d.maxTemp : d.minTemp}`);
        }
      }

      throw new Error(`CSV文件包含${dryRunResult.invalidCount}条非法数据，整批导入失败：${allErrors.join('; ')}`);
    }

    const context: PreCheckContext = {
      lastReadingTimes: new Map<string, number>(),
      rowIndex: 0,
      openAlarmsCache: new Map<string, Alarm[]>(),
      thresholdCache: new Map<string, Threshold>(),
    };

    const validatedRows: Array<{
      row: CsvReadingRow;
      validated: Awaited<ReturnType<typeof preCheckAndClassifyRow>>;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      context.rowIndex = i + 1;
      const row = rows[i];
      const validated = await preCheckAndClassifyRow(
        row,
        context,
        this.deviceRepo,
        this.readingRepo,
        this.thresholdRepo,
        this.alarmRepo
      );

      if (!validated.valid || !validated.parsed) {
        throw new Error(validated.error || `第${i + 1}行：未知错误`);
      }

      validatedRows.push({ row, validated });
    }

    let generatedAlarms = 0;
    let recoveredAlarms = 0;
    let batchId = '';

    try {
      runInTransaction(() => {
        const batch = this.importBatchRepo.create({
          fileName,
          totalCount: rows.length,
          successCount: 0,
          failedCount: 0,
          errorDetails: '',
          createdBy: operator,
          status: BatchStatus.PROCESSING,
        });
        batchId = batch.id;

        const rowResults: Array<Omit<BatchRowResult, 'id' | 'createdAt'>> = [];

        for (const { validated } of validatedRows) {
          const { deviceId, temperature, readingTime } = validated.parsed!;
          const device = this.deviceRepo.findById(deviceId)!;

          rowResults.push({
            importBatchId: batch.id,
            rowIndex: validated.rowIndex,
            deviceId,
            temperature,
            readingTime,
            status: RowStatus.SUCCESS,
          });

          const reading = this.readingRepo.create({
            deviceId,
            temperature,
            readingTime,
            importBatchId: batch.id,
          });

          const alarmResult = this.alarmService.processReadingForAlarms(
            reading,
            deviceId,
            device.storeId
          );

          if (alarmResult.createdAlarm) generatedAlarms++;
          if (alarmResult.recoveredAlarm) recoveredAlarms++;
        }

        for (const rowResult of rowResults) {
          this.batchRowResultRepo.create(rowResult);
        }

        this.importBatchRepo.update(batch.id, {
          successCount: rows.length,
          failedCount: 0,
          errorDetails: '',
          status: BatchStatus.COMPLETED,
          completedAt: Date.now(),
        });

        this.auditRepo.create({
          operationType: OperationType.READING_IMPORT,
          entityId: batch.id,
          entityType: 'import_batch',
          operator,
          details: `导入CSV文件"${fileName}"，共${rows.length}条，成功${rows.length}条，生成告警${generatedAlarms}条，恢复告警${recoveredAlarms}条`,
          importBatchId: batch.id,
        });
      });
    } catch (error) {
      logger.error('Import failed, rolling back', error);
      throw error;
    }

    return {
      batchId,
      successCount: rows.length,
      failedCount: 0,
      errors: [],
      generatedAlarms,
      recoveredAlarms,
      status: BatchStatus.COMPLETED,
    };
  }

  async importFromCsvWithHeader(
    fileStream: Readable,
    fileName: string,
    operator: string
  ): Promise<ImportResult> {
    return this.importFromCsv(fileStream, fileName, operator);
  }

  getBatchDetail(batchId: string, operator: string, filters: BatchDetailFilters = {}): PaginatedBatchDetail {
    checkViewBatchesPermission(operator);

    const batch = this.importBatchRepo.findById(batchId);
    if (!batch) {
      throw new NotFoundError(`导入批次"${batchId}"不存在`, { batchId });
    }

    if (batch.status === BatchStatus.ROLLED_BACK) {
      throw new BusinessError(
        `导入批次"${batchId}"已回滚，仅可查看批次元信息`,
        'BATCH_ROLLED_BACK',
        { batchId, status: batch.status }
      );
    }

    const rowStatusFilter = filters.rowStatus === 'all' ? undefined : filters.rowStatus;
    const queryFilters: QueryFilters = {
      rowStatus: rowStatusFilter,
      page: filters.page || 1,
      pageSize: filters.pageSize || 100,
    };

    const rowResults = this.batchRowResultRepo.findByBatchId(batchId, queryFilters);
    const alarms = this.alarmRepo.findAll({ importBatchId: batchId, pageSize: 1000 }).items;
    const auditLogs = this.auditRepo.findAll({ importBatchId: batchId, pageSize: 1000 }).items;

    return {
      batch,
      rowResults,
      alarms,
      auditLogs,
    };
  }

  getBatchDetailAllRows(batchId: string, operator: string, filters: BatchDetailFilters = {}): BatchDetail {
    checkViewBatchesPermission(operator);

    const batch = this.importBatchRepo.findById(batchId);
    if (!batch) {
      throw new NotFoundError(`导入批次"${batchId}"不存在`, { batchId });
    }

    if (batch.status === BatchStatus.ROLLED_BACK) {
      throw new BusinessError(
        `导入批次"${batchId}"已回滚，仅可查看批次元信息`,
        'BATCH_ROLLED_BACK',
        { batchId, status: batch.status }
      );
    }

    const rowStatusFilter = filters.rowStatus === 'all' ? undefined : filters.rowStatus;
    const queryFilters: QueryFilters = {
      rowStatus: rowStatusFilter,
    };

    const rowResults = this.batchRowResultRepo.findAllByBatchId(batchId).filter(r =>
      rowStatusFilter ? r.status === rowStatusFilter : true
    );
    const alarms = this.alarmRepo.findAll({ importBatchId: batchId, pageSize: 1000 }).items;
    const auditLogs = this.auditRepo.findAll({ importBatchId: batchId, pageSize: 1000 }).items;

    return {
      batch,
      rowResults,
      alarms,
      auditLogs,
    };
  }

  exportBatchDetail(
    batchId: string,
    format: 'json' | 'csv',
    operator: string,
    filters: BatchDetailFilters = {}
  ): { content: string; contentType: string; filename: string } {
    checkExportBatchesPermission(operator);

    const detail = this.getBatchDetailAllRows(batchId, operator, filters);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    const orderedBatch = formatExportRow(detail.batch, EXPORT_BATCH_FIELDS);
    const orderedRows = detail.rowResults.map(r => formatExportRow(r, EXPORT_ROW_FIELDS));
    const orderedAlarms = detail.alarms.map(a => formatExportRow(a, EXPORT_ALARM_FIELDS));
    const orderedAuditLogs = detail.auditLogs.map(l => formatExportRow(l, EXPORT_AUDIT_FIELDS));

    const exportData = {
      batch: orderedBatch,
      rowResults: orderedRows,
      alarms: orderedAlarms,
      auditLogs: orderedAuditLogs,
      filters: {
        rowStatus: filters.rowStatus || 'all',
      },
    };

    if (format === 'json') {
      return {
        content: JSON.stringify(exportData, null, 2),
        contentType: 'application/json; charset=utf-8',
        filename: `batch_detail_${batchId}_${timestamp}.json`,
      };
    }

    const csvLines: string[] = [];
    csvLines.push('=== 批次信息 ===');
    csvLines.push(EXPORT_BATCH_FIELDS.join(','));
    csvLines.push(exportToCsvLine(EXPORT_BATCH_FIELDS.map(f => orderedBatch[f as string])));

    csvLines.push('');
    csvLines.push('=== 逐行结果 ===');
    csvLines.push(EXPORT_ROW_FIELDS.join(','));
    for (const row of orderedRows) {
      csvLines.push(exportToCsvLine(EXPORT_ROW_FIELDS.map(f => row[f as string])));
    }

    csvLines.push('');
    csvLines.push('=== 关联告警 ===');
    csvLines.push(EXPORT_ALARM_FIELDS.join(','));
    for (const alarm of orderedAlarms) {
      csvLines.push(exportToCsvLine(EXPORT_ALARM_FIELDS.map(f => alarm[f as string])));
    }

    csvLines.push('');
    csvLines.push('=== 审计日志 ===');
    csvLines.push(EXPORT_AUDIT_FIELDS.join(','));
    for (const log of orderedAuditLogs) {
      csvLines.push(exportToCsvLine(EXPORT_AUDIT_FIELDS.map(f => log[f as string])));
    }

    return {
      content: '\uFEFF' + csvLines.join('\n'),
      contentType: 'text/csv; charset=utf-8',
      filename: `batch_detail_${batchId}_${timestamp}.csv`,
    };
  }
}
