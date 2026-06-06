import { Readable } from 'stream';
import csvParser from 'csv-parser';
import crypto from 'crypto';
import { runInTransaction } from '../../storage/database';
import {
  DeviceRepository,
  ReadingRepository,
  ImportBatchRepository,
  AuditRepository,
  ThresholdRepository,
  AlarmRepository,
  BatchRowResultRepository,
  IdempotencyKeyRepository,
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
  parseDateTime,
} from '../rules';
import logger from '../../utils/logger';
import { NotFoundError, BusinessError, ConflictError } from '../../utils/errors';

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
  'idempotencyKey',
  'fileContentHash',
  'isIdempotencyHit',
  'originalBatchId',
  'submitCount',
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

function computeFileHash(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
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
    private alarmRepo: AlarmRepository,
    private idempotencyKeyRepo: IdempotencyKeyRepository
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
    operator: string,
    idempotencyKey?: string
  ): Promise<ImportResult> {
    checkImportPermission(operator);

    const buffer = await this.streamToBuffer(fileStream);
    const fileContentHash = computeFileHash(buffer);
    const rows = await this.parseCsvWithAutoHeaderDetection(Readable.from(buffer));

    if (idempotencyKey) {
      const idemRecord = this.idempotencyKeyRepo.findByKeyAndOperator(idempotencyKey, operator);

      if (idemRecord) {
        if (idemRecord.fileContentHash === fileContentHash) {
          return this.handleIdempotencyHit(idemRecord, fileContentHash, operator, idempotencyKey);
        } else {
          return this.handleIdempotencyConflict(idemRecord, fileContentHash, operator, idempotencyKey);
        }
      }
    }

    return await this.performActualImport(
      rows,
      fileName,
      operator,
      fileContentHash,
      idempotencyKey
    );
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private handleIdempotencyHit(
    idemRecord: { originalBatchId: string; submitCount: number; id: string },
    fileContentHash: string,
    operator: string,
    idempotencyKey: string
  ): ImportResult {
    const updatedIdem = this.idempotencyKeyRepo.updateSubmitCount(idemRecord.id)!;
    const originalBatch = this.importBatchRepo.findById(idemRecord.originalBatchId)!;

    const hitBatch = this.importBatchRepo.create({
      fileName: originalBatch.fileName,
      totalCount: originalBatch.totalCount,
      successCount: originalBatch.successCount,
      failedCount: originalBatch.failedCount,
      errorDetails: originalBatch.errorDetails,
      createdBy: operator,
      status: originalBatch.status,
      completedAt: originalBatch.completedAt,
      idempotencyKey,
      fileContentHash,
      isIdempotencyHit: true,
      originalBatchId: originalBatch.id,
      submitCount: updatedIdem.submitCount,
    });

    this.auditRepo.create({
      operationType: OperationType.IDEMPOTENCY_HIT,
      entityId: hitBatch.id,
      entityType: 'import_batch',
      operator,
      details: `幂等键命中，返回原始批次"${originalBatch.id}"，当前提交次数: ${updatedIdem.submitCount}`,
      importBatchId: hitBatch.id,
    });

    return {
      batchId: hitBatch.id,
      successCount: originalBatch.successCount,
      failedCount: originalBatch.failedCount,
      errors: originalBatch.errorDetails ? originalBatch.errorDetails.split('; ') : [],
      generatedAlarms: 0,
      recoveredAlarms: 0,
      status: originalBatch.status,
      idempotencyKey,
      isIdempotencyHit: true,
      originalBatchId: originalBatch.id,
      submitCount: updatedIdem.submitCount,
    };
  }

  private handleIdempotencyConflict(
    idemRecord: { originalBatchId: string; fileContentHash: string; id: string },
    fileContentHash: string,
    operator: string,
    idempotencyKey: string
  ): ImportResult {
    this.auditRepo.create({
      operationType: OperationType.IDEMPOTENCY_CONFLICT,
      entityId: idemRecord.originalBatchId,
      entityType: 'import_batch',
      operator,
      details: `幂等键冲突！同一key"${idempotencyKey}"提交了不同的文件内容。原始哈希: ${idemRecord.fileContentHash.slice(0, 16)}..., 当前哈希: ${fileContentHash.slice(0, 16)}...`,
      importBatchId: idemRecord.originalBatchId,
    });

    throw new ConflictError(
      `幂等键"${idempotencyKey}"已被使用，但文件内容不同。请使用不同的key或保持文件内容一致。`,
      {
        idempotencyKey,
        operator,
        originalBatchId: idemRecord.originalBatchId,
        originalFileHash: idemRecord.fileContentHash,
        currentFileHash: fileContentHash,
      }
    );
  }

  private async performActualImport(
    rows: CsvReadingRow[],
    fileName: string,
    operator: string,
    fileContentHash: string,
    idempotencyKey?: string
  ): Promise<ImportResult> {
    const context: PreCheckContext = {
      lastReadingTimes: new Map<string, number>(),
      seenTimestamps: new Map<string, Set<number>>(),
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

      if (validated.valid && validated.parsed) {
        context.lastReadingTimes.set(validated.parsed.deviceId, validated.parsed.readingTime);
      }

      validatedRows.push({ row, validated });
    }

    const successRows = validatedRows.filter(v => v.validated.valid && v.validated.parsed);
    const failedRows = validatedRows.filter(v => !v.validated.valid || !v.validated.parsed);
    const errors = failedRows.map(f => f.validated.error || `第${f.validated.rowIndex}行：未知错误`);

    let generatedAlarms = 0;
    let recoveredAlarms = 0;
    let batchId = '';

    runInTransaction(() => {
      const batch = this.importBatchRepo.create({
        fileName,
        totalCount: rows.length,
        successCount: 0,
        failedCount: 0,
        errorDetails: '',
        createdBy: operator,
        status: BatchStatus.PROCESSING,
        idempotencyKey,
        fileContentHash,
        isIdempotencyHit: false,
        submitCount: 1,
      });
      batchId = batch.id;

      for (const { validated } of successRows) {
        const { deviceId, temperature, readingTime } = validated.parsed!;
        const device = this.deviceRepo.findById(deviceId)!;

        this.batchRowResultRepo.create({
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

      for (const { row, validated } of failedRows) {
        const parsed = validated.parsed;
        const temperature = parsed?.temperature ?? parseFloat(row.temperature);
        const readingTime = parsed?.readingTime ?? parseDateTime(row.readingTime);
        this.batchRowResultRepo.create({
          importBatchId: batch.id,
          rowIndex: validated.rowIndex,
          deviceId: row.deviceId,
          temperature: isNaN(temperature) ? undefined : temperature,
          readingTime: readingTime === null ? undefined : readingTime,
          status: RowStatus.FAILED,
          errorMessage: validated.error,
        });
      }

      this.importBatchRepo.update(batch.id, {
        successCount: successRows.length,
        failedCount: failedRows.length,
        errorDetails: errors.length > 0 ? errors.join('; ') : '',
        status: BatchStatus.COMPLETED,
        completedAt: Date.now(),
      });

      if (idempotencyKey) {
        this.idempotencyKeyRepo.create({
          idempotencyKey,
          operator,
          fileContentHash,
          originalBatchId: batch.id,
        });
      }

      this.auditRepo.create({
        operationType: OperationType.READING_IMPORT,
        entityId: batch.id,
        entityType: 'import_batch',
        operator,
        details: `导入CSV文件"${fileName}"，共${rows.length}条，成功${successRows.length}条，失败${failedRows.length}条，生成告警${generatedAlarms}条，恢复告警${recoveredAlarms}条${idempotencyKey ? `，幂等键: ${idempotencyKey}` : ''}`,
        importBatchId: batch.id,
      });
    });

    return {
      batchId,
      successCount: successRows.length,
      failedCount: failedRows.length,
      errors,
      generatedAlarms,
      recoveredAlarms,
      status: BatchStatus.COMPLETED,
      idempotencyKey,
      isIdempotencyHit: false,
      submitCount: 1,
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

    const dataBatchId = batch.originalBatchId || batchId;

    const rowStatusFilter = filters.rowStatus === 'all' ? undefined : filters.rowStatus;
    const queryFilters: QueryFilters = {
      rowStatus: rowStatusFilter,
      page: filters.page || 1,
      pageSize: filters.pageSize || 100,
    };

    const rowResults = this.batchRowResultRepo.findByBatchId(dataBatchId, queryFilters);
    const alarms = this.alarmRepo.findAll({ importBatchId: dataBatchId, pageSize: 1000 }).items;
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

    const dataBatchId = batch.originalBatchId || batchId;

    const rowStatusFilter = filters.rowStatus === 'all' ? undefined : filters.rowStatus;
    const queryFilters: QueryFilters = {
      rowStatus: rowStatusFilter,
    };

    const rowResults = this.batchRowResultRepo.findAllByBatchId(dataBatchId).filter(r =>
      rowStatusFilter ? r.status === rowStatusFilter : true
    );
    const alarms = this.alarmRepo.findAll({ importBatchId: dataBatchId, pageSize: 1000 }).items;
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
