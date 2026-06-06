import { Readable } from 'stream';
import csvParser from 'csv-parser';
import crypto from 'crypto';
import { runInTransaction, prepare } from '../../storage/database';
import {
  DeviceRepository,
  ReadingRepository,
  ImportBatchRepository,
  AuditRepository,
  ThresholdRepository,
  AlarmRepository,
  BatchRowResultRepository,
  IdempotencyKeyRepository,
  BatchRowRemarkRepository,
} from '../../storage/repositories';
import { ValidationError } from '../../utils/errors';
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
  PaginatedResult,
  BatchRowRemark,
  BatchRowRemarkStats,
  BatchRowResultWithRemark,
  BatchDetailWithRemarks,
  BatchDetailAllRowsWithRemarks,
  UpsertRemarkResult,
  DispositionStats,
  RemarkFilters,
  PaginatedBatchListWithDisposition,
} from '../../types';
import {
  validateImportRow,
  RowValidationContext,
  checkImportPermission,
  checkDryRunPermission,
  checkViewBatchesPermission,
  checkExportBatchesPermission,
  checkManageRowRemarksPermission,
  performDryRun,
  preCheckAndClassifyRow,
  PreCheckContext,
  parseDateTime,
} from '../rules';
import logger from '../../utils/logger';
import { NotFoundError, BusinessError, ConflictError } from '../../utils/errors';

const EXPORT_ROW_FIELDS: Array<keyof BatchRowResultWithRemark> = [
  'rowIndex',
  'deviceId',
  'temperature',
  'readingTime',
  'status',
  'errorMessage',
  'importBatchId',
  'id',
  'createdAt',
  'remark',
];

const EXPORT_REMARK_FIELDS: Array<keyof BatchRowRemark> = [
  'remarkContent',
  'handledBy',
  'handledAt',
  'createdAt',
  'updatedAt',
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
    private batchRowRemarkRepo: BatchRowRemarkRepository,
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

  private joinRemarksWithRows(
    rows: BatchRowResult[],
    remarks: BatchRowRemark[]
  ): BatchRowResultWithRemark[] {
    const remarkMap = new Map<number, BatchRowRemark>();
    for (const remark of remarks) {
      remarkMap.set(remark.rowIndex, remark);
    }
    return rows.map(row => ({
      ...row,
      remark: remarkMap.get(row.rowIndex) || null,
    }));
  }

  private extractRemarkFilters(filters: BatchDetailFilters): RemarkFilters {
    return {
      remarkStatus: filters.remarkStatus,
      handledBy: filters.handledBy,
      remarkStartTime: filters.remarkStartTime,
      remarkEndTime: filters.remarkEndTime,
    };
  }

  getBatchDetailWithRemarks(
    batchId: string,
    operator: string,
    filters: BatchDetailFilters = {}
  ): BatchDetailWithRemarks {
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

    const remarkFilters = this.extractRemarkFilters(filters);
    const hasRemarkFilters = remarkFilters.remarkStatus || remarkFilters.handledBy || remarkFilters.remarkStartTime || remarkFilters.remarkEndTime;

    let rowResults: PaginatedResult<BatchRowResult>;
    let filteredRemarks: BatchRowRemark[];

    if (hasRemarkFilters) {
      rowResults = this.batchRowResultRepo.findByBatchIdWithRemarkFilters(dataBatchId, queryFilters, remarkFilters);
      filteredRemarks = this.batchRowRemarkRepo.findByBatchIdWithFilters(dataBatchId, remarkFilters);
    } else {
      rowResults = this.batchRowResultRepo.findByBatchId(dataBatchId, queryFilters);
      filteredRemarks = this.batchRowRemarkRepo.findByBatchId(dataBatchId);
    }

    const rowResultsWithRemark: PaginatedResult<BatchRowResultWithRemark> = {
      ...rowResults,
      items: this.joinRemarksWithRows(rowResults.items, filteredRemarks),
    };

    const alarms = this.alarmRepo.findAll({ importBatchId: dataBatchId, pageSize: 1000 }).items;
    const auditLogs = this.auditRepo.findAll({ importBatchId: batchId, pageSize: 1000 }).items;
    const remarkStats = this.batchRowRemarkRepo.getRemarkStatsForBatch(dataBatchId);
    const dispositionStats = this.batchRowRemarkRepo.getDispositionStatsForBatch(dataBatchId, remarkFilters);
    const appliedFilters = this.extractRemarkFilters(filters);

    return {
      batch: { ...batch, remarkStats },
      dispositionStats,
      rowResults: rowResultsWithRemark,
      alarms,
      auditLogs,
      appliedFilters,
    };
  }

  getBatchDetailAllRowsWithRemarks(
    batchId: string,
    operator: string,
    filters: BatchDetailFilters = {}
  ): BatchDetailAllRowsWithRemarks {
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

    const remarkFilters = this.extractRemarkFilters(filters);
    const hasRemarkFilters = remarkFilters.remarkStatus || remarkFilters.handledBy || remarkFilters.remarkStartTime || remarkFilters.remarkEndTime;

    let rowResults: BatchRowResult[];
    let filteredRemarks: BatchRowRemark[];

    if (hasRemarkFilters) {
      rowResults = this.batchRowResultRepo.findAllByBatchIdWithRemarkFilters(dataBatchId, queryFilters, remarkFilters);
      filteredRemarks = this.batchRowRemarkRepo.findByBatchIdWithFilters(dataBatchId, remarkFilters);
    } else {
      rowResults = this.batchRowResultRepo.findAllByBatchId(dataBatchId);
      if (rowStatusFilter) {
        rowResults = rowResults.filter(r => r.status === rowStatusFilter);
      }
      filteredRemarks = this.batchRowRemarkRepo.findByBatchId(dataBatchId);
    }

    const rowResultsWithRemark = this.joinRemarksWithRows(rowResults, filteredRemarks);

    const alarms = this.alarmRepo.findAll({ importBatchId: dataBatchId, pageSize: 1000 }).items;
    const auditLogs = this.auditRepo.findAll({ importBatchId: batchId, pageSize: 1000 }).items;
    const remarkStats = this.batchRowRemarkRepo.getRemarkStatsForBatch(dataBatchId);
    const dispositionStats = this.batchRowRemarkRepo.getDispositionStatsForBatch(dataBatchId, remarkFilters);
    const appliedFilters = this.extractRemarkFilters(filters);

    return {
      batch: { ...batch, remarkStats },
      dispositionStats,
      rowResults: rowResultsWithRemark,
      alarms,
      auditLogs,
      appliedFilters,
    };
  }

  getBatchListWithDisposition(
    operator: string,
    filters: QueryFilters & { batchStatus?: BatchStatus } = {}
  ): PaginatedBatchListWithDisposition {
    checkViewBatchesPermission(operator);

    const remarkFilters = this.extractRemarkFilters(filters);
    const hasRemarkFilters = remarkFilters.remarkStatus || remarkFilters.handledBy || remarkFilters.remarkStartTime || remarkFilters.remarkEndTime;

    let result: PaginatedResult<ImportBatch> & { matchingBatchIds: string[] };

    if (hasRemarkFilters) {
      result = this.importBatchRepo.findAllWithRemarkFilters(filters, remarkFilters);
    } else {
      const basicResult = this.importBatchRepo.findAll(filters);
      const allIds = prepare(`
        SELECT id FROM import_batches
        ORDER BY created_at DESC
      `).all() as Array<{ id: string }>;
      result = { ...basicResult, matchingBatchIds: allIds.map(r => r.id) };
    }

    const itemsWithStats = result.items.map(batch => {
      const dataBatchId = (batch as any).originalBatchId || batch.id;
      const remarkStats = this.batchRowRemarkRepo.getRemarkStatsForBatch(dataBatchId);
      const dispositionStats = this.batchRowRemarkRepo.getDispositionStatsForBatch(dataBatchId, remarkFilters);
      return { ...batch, remarkStats, dispositionStats };
    });

    const summary = this.batchRowRemarkRepo.getBatchListDispositionStats(result.matchingBatchIds);
    const appliedFilters = this.extractRemarkFilters(filters);

    return {
      items: itemsWithStats,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      summary,
      appliedFilters,
    };
  }

  upsertRowRemark(
    batchId: string,
    rowIndex: number,
    remarkContent: string,
    operator: string
  ): UpsertRemarkResult {
    checkManageRowRemarksPermission(operator);

    const batch = this.importBatchRepo.findById(batchId);
    if (!batch) {
      throw new NotFoundError(`导入批次"${batchId}"不存在`, { batchId });
    }

    if (batch.status === BatchStatus.ROLLED_BACK) {
      throw new BusinessError(
        `导入批次"${batchId}"已回滚，无法添加备注`,
        'BATCH_ROLLED_BACK',
        { batchId, status: batch.status }
      );
    }

    const dataBatchId = batch.originalBatchId || batchId;

    const rowResult = this.batchRowResultRepo.findAllByBatchId(dataBatchId)
      .find(r => r.rowIndex === rowIndex);

    if (!rowResult) {
      throw new NotFoundError(
        `批次"${batchId}"中不存在行号"${rowIndex}"`,
        { batchId, rowIndex }
      );
    }

    if (rowResult.status !== RowStatus.FAILED) {
      throw new BusinessError(
        `仅能对失败行添加备注，行号"${rowIndex}"的状态是"${rowResult.status}"`,
        'ROW_NOT_FAILED',
        { batchId, rowIndex, rowStatus: rowResult.status }
      );
    }

    const isClear = remarkContent.trim() === '';
    const now = Date.now();

    if (isClear) {
      const existingRemark = this.batchRowRemarkRepo.findByBatchIdAndRowIndex(dataBatchId, rowIndex);
      if (!existingRemark) {
        return {
          remark: {
            importBatchId: dataBatchId,
            rowIndex,
            remarkContent: '',
            handledBy: operator,
            handledAt: now,
          },
          isNew: false,
          isClear: true,
        };
      }

      this.batchRowRemarkRepo.deleteByBatchIdAndRowIndex(dataBatchId, rowIndex);

      this.auditRepo.create({
        operationType: OperationType.BATCH_ROW_REMARK_CLEAR,
        entityId: `${dataBatchId}-row-${rowIndex}`,
        entityType: 'batch_row_remark',
        operator,
        details: `清空批次"${batchId}"行号"${rowIndex}"的异常处置备注，原备注: ${existingRemark.remarkContent}`,
        importBatchId: batchId,
      });

      return {
        remark: {
          ...existingRemark,
          remarkContent: '',
          handledBy: operator,
          handledAt: now,
          updatedAt: now,
        },
        isNew: false,
        isClear: true,
      };
    }

    const { remark, isNew } = this.batchRowRemarkRepo.upsert({
      importBatchId: dataBatchId,
      rowIndex,
      remarkContent: remarkContent.trim(),
      handledBy: operator,
      handledAt: now,
    });

    this.auditRepo.create({
      operationType: OperationType.BATCH_ROW_REMARK_UPDATE,
      entityId: `${dataBatchId}-row-${rowIndex}`,
      entityType: 'batch_row_remark',
      operator,
      details: `${isNew ? '新增' : '更新'}批次"${batchId}"行号"${rowIndex}"的异常处置备注: ${remarkContent.trim()}`,
      importBatchId: batchId,
    });

    return { remark, isNew, isClear: false };
  }

  getRowRemark(
    batchId: string,
    rowIndex: number,
    operator: string
  ): BatchRowRemark | null {
    checkViewBatchesPermission(operator);

    const batch = this.importBatchRepo.findById(batchId);
    if (!batch) {
      throw new NotFoundError(`导入批次"${batchId}"不存在`, { batchId });
    }

    const dataBatchId = batch.originalBatchId || batchId;

    const rowResult = this.batchRowResultRepo.findAllByBatchId(dataBatchId)
      .find(r => r.rowIndex === rowIndex);

    if (!rowResult) {
      throw new NotFoundError(
        `批次"${batchId}"中不存在行号"${rowIndex}"`,
        { batchId, rowIndex }
      );
    }

    return this.batchRowRemarkRepo.findByBatchIdAndRowIndex(dataBatchId, rowIndex);
  }

  exportBatchDetail(
    batchId: string,
    format: 'json' | 'csv',
    operator: string,
    filters: BatchDetailFilters = {}
  ): { content: string; contentType: string; filename: string } {
    checkExportBatchesPermission(operator);

    const detail = this.getBatchDetailAllRowsWithRemarks(batchId, operator, filters);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    const batchWithStats = { ...detail.batch };
    const remarkStats = (batchWithStats as any).remarkStats;
    const dispositionStats = (detail as any).dispositionStats;
    const orderedBatch = formatExportRow(batchWithStats, EXPORT_BATCH_FIELDS);
    (orderedBatch as any).remarkStats = remarkStats;
    (orderedBatch as any).dispositionStats = dispositionStats;

    const orderedRows = detail.rowResults.map(r => {
      const rowExport: any = formatExportRow(r, EXPORT_ROW_FIELDS.filter(f => f !== 'remark'));
      if (r.remark) {
        rowExport.remark = formatExportRow(r.remark, EXPORT_REMARK_FIELDS);
      } else {
        rowExport.remark = null;
      }
      return rowExport;
    });
    const orderedAlarms = detail.alarms.map(a => formatExportRow(a, EXPORT_ALARM_FIELDS));
    const orderedAuditLogs = detail.auditLogs.map(l => formatExportRow(l, EXPORT_AUDIT_FIELDS));

    const appliedFilters = (detail as any).appliedFilters || {};
    const exportData = {
      batch: orderedBatch,
      dispositionStats,
      rowResults: orderedRows,
      alarms: orderedAlarms,
      auditLogs: orderedAuditLogs,
      filters: {
        rowStatus: filters.rowStatus || 'all',
        remarkStatus: appliedFilters.remarkStatus,
        handledBy: appliedFilters.handledBy,
        remarkStartTime: appliedFilters.remarkStartTime,
        remarkEndTime: appliedFilters.remarkEndTime,
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
    const batchFields = [...EXPORT_BATCH_FIELDS, 'remarkStats', 'dispositionStats'];
    csvLines.push(batchFields.join(','));
    const batchValues = EXPORT_BATCH_FIELDS.map(f => orderedBatch[f as string]);
    batchValues.push(JSON.stringify(remarkStats));
    batchValues.push(JSON.stringify(dispositionStats));
    csvLines.push(exportToCsvLine(batchValues));

    csvLines.push('');
    csvLines.push('=== 应用筛选条件 ===');
    csvLines.push('筛选条件,值');
    csvLines.push(`rowStatus,${filters.rowStatus || 'all'}`);
    csvLines.push(`remarkStatus,${appliedFilters.remarkStatus || ''}`);
    csvLines.push(`handledBy,${appliedFilters.handledBy || ''}`);
    csvLines.push(`remarkStartTime,${appliedFilters.remarkStartTime || ''}`);
    csvLines.push(`remarkEndTime,${appliedFilters.remarkEndTime || ''}`);

    csvLines.push('');
    csvLines.push('=== 逐行结果 ===');
    const rowFields = EXPORT_ROW_FIELDS.filter(f => f !== 'remark');
    const csvRowFields = [...rowFields, ...EXPORT_REMARK_FIELDS.map(f => `remark_${f}`)];
    csvLines.push(csvRowFields.join(','));
    for (const row of orderedRows) {
      const rowValues = rowFields.map(f => row[f as string]);
      if (row.remark) {
        for (const f of EXPORT_REMARK_FIELDS) {
          rowValues.push(row.remark[f]);
        }
      } else {
        for (const f of EXPORT_REMARK_FIELDS) {
          rowValues.push('');
        }
      }
      csvLines.push(exportToCsvLine(rowValues));
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
