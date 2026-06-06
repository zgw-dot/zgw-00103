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
  Alarm,
  AuditLog,
  Threshold,
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

  getBatchDetail(batchId: string, operator: string): BatchDetail {
    checkViewBatchesPermission(operator);

    const batch = this.importBatchRepo.findById(batchId);
    if (!batch) {
      throw new Error(`导入批次"${batchId}"不存在`);
    }

    const rowResults = this.batchRowResultRepo.findAllByBatchId(batchId);
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
    operator: string
  ): { content: string; contentType: string; filename: string } {
    checkExportBatchesPermission(operator);

    const detail = this.getBatchDetail(batchId, operator);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (format === 'json') {
      return {
        content: JSON.stringify(detail, null, 2),
        contentType: 'application/json; charset=utf-8',
        filename: `batch_detail_${batchId}_${timestamp}.json`,
      };
    }

    const batchInfoRows = [
      ['批次ID', detail.batch.id],
      ['文件名', detail.batch.fileName],
      ['状态', detail.batch.status],
      ['操作者', detail.batch.createdBy],
      ['创建时间', new Date(detail.batch.createdAt).toLocaleString('zh-CN')],
      ['完成时间', detail.batch.completedAt ? new Date(detail.batch.completedAt).toLocaleString('zh-CN') : ''],
      ['总条数', String(detail.batch.totalCount)],
      ['成功条数', String(detail.batch.successCount)],
      ['失败条数', String(detail.batch.failedCount)],
    ];

    const rowHeaders = ['行号', '设备ID', '温度', '读数时间', '状态', '错误信息'];
    const rowData = detail.rowResults.map(r => [
      String(r.rowIndex),
      r.deviceId,
      r.temperature !== undefined ? String(r.temperature) : '',
      r.readingTime ? new Date(r.readingTime).toLocaleString('zh-CN') : '',
      r.status,
      r.errorMessage || '',
    ]);

    const alarmHeaders = ['告警ID', '设备ID', '类型', '阈值', '温度', '读数时间', '状态'];
    const alarmData = detail.alarms.map(a => [
      a.id,
      a.deviceId,
      a.type,
      String(a.threshold),
      String(a.temperature),
      new Date(a.readingTime).toLocaleString('zh-CN'),
      a.status,
    ]);

    const auditHeaders = ['操作类型', '操作者', '详情', '操作时间'];
    const auditData = detail.auditLogs.map(l => [
      l.operationType,
      l.operator,
      `"${(l.details || '').replace(/"/g, '""')}"`,
      new Date(l.createdAt).toLocaleString('zh-CN'),
    ]);

    const csvLines: string[] = [];
    csvLines.push('=== 批次信息 ===');
    csvLines.push(...batchInfoRows.map(r => r.join(',')));
    csvLines.push('');
    csvLines.push('=== 逐行结果 ===');
    csvLines.push(rowHeaders.join(','));
    csvLines.push(...rowData.map(r => r.join(',')));
    csvLines.push('');
    csvLines.push('=== 关联告警 ===');
    csvLines.push(alarmHeaders.join(','));
    csvLines.push(...alarmData.map(r => r.join(',')));
    csvLines.push('');
    csvLines.push('=== 审计日志 ===');
    csvLines.push(auditHeaders.join(','));
    csvLines.push(...auditData.map(r => r.join(',')));

    return {
      content: '\uFEFF' + csvLines.join('\n'),
      contentType: 'text/csv; charset=utf-8',
      filename: `batch_detail_${batchId}_${timestamp}.csv`,
    };
  }
}
