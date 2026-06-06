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

  async dryRunImport(
    fileStream: Readable,
    fileName: string,
    operator: string
  ): Promise<DryRunResult> {
    checkDryRunPermission(operator);

    const rows: CsvReadingRow[] = [];

    await new Promise<void>((resolve, reject) => {
      fileStream
        .pipe(csvParser({ headers: ['deviceId', 'temperature', 'readingTime'], skipLines: 0 }))
        .on('data', (row: CsvReadingRow) => {
          rows.push(row);
        })
        .on('end', resolve)
        .on('error', reject);
    });

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

    const rows: CsvReadingRow[] = [];
    await new Promise<void>((resolve, reject) => {
      fileStream
        .pipe(csvParser({ headers: ['deviceId', 'temperature', 'readingTime'], skipLines: 0 }))
        .on('data', (row: CsvReadingRow) => {
          rows.push(row);
        })
        .on('end', resolve)
        .on('error', reject);
    });

    const batch = this.importBatchRepo.create({
      fileName,
      totalCount: rows.length,
      successCount: 0,
      failedCount: 0,
      errorDetails: '',
      createdBy: operator,
      status: BatchStatus.PROCESSING,
    });

    const context: PreCheckContext = {
      lastReadingTimes: new Map<string, number>(),
      rowIndex: 0,
      openAlarmsCache: new Map<string, Alarm[]>(),
      thresholdCache: new Map<string, Threshold>(),
    };

    const rowResults: Array<Omit<BatchRowResult, 'id' | 'createdAt'>> = [];
    const validReadings: Array<{
      reading: Omit<TemperatureReading, 'id' | 'createdAt'>;
      deviceId: string;
      storeId: string;
    }> = [];
    const errors: string[] = [];

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
        errors.push(validated.error || `第${i + 1}行：未知错误`);
        rowResults.push({
          importBatchId: batch.id,
          rowIndex: i + 1,
          deviceId: row.deviceId,
          temperature: validated.parsed?.temperature,
          readingTime: validated.parsed?.readingTime,
          status: RowStatus.FAILED,
          errorMessage: validated.error,
        });
        continue;
      }

      const { deviceId, temperature, readingTime } = validated.parsed;
      const device = this.deviceRepo.findById(deviceId)!;

      rowResults.push({
        importBatchId: batch.id,
        rowIndex: i + 1,
        deviceId,
        temperature,
        readingTime,
        status: RowStatus.SUCCESS,
      });

      validReadings.push({
        reading: {
          deviceId,
          temperature,
          readingTime,
          importBatchId: batch.id,
        },
        deviceId,
        storeId: device.storeId,
      });
    }

    let generatedAlarms = 0;
    let recoveredAlarms = 0;

    try {
      runInTransaction(() => {
        for (const vr of validReadings) {
          const reading = this.readingRepo.create(vr.reading);

          const alarmResult = this.alarmService.processReadingForAlarms(
            reading,
            vr.deviceId,
            vr.storeId
          );

          if (alarmResult.createdAlarm) generatedAlarms++;
          if (alarmResult.recoveredAlarm) recoveredAlarms++;
        }

        for (const rowResult of rowResults) {
          this.batchRowResultRepo.create(rowResult);
        }

        this.importBatchRepo.update(batch.id, {
          successCount: validReadings.length,
          failedCount: errors.length,
          errorDetails: errors.length > 0 ? JSON.stringify(errors) : '',
          status: BatchStatus.COMPLETED,
          completedAt: Date.now(),
        });
      });
    } catch (error) {
      logger.error('Import transaction failed, rolling back', error);

      this.importBatchRepo.updateStatus(batch.id, BatchStatus.ROLLED_BACK, Date.now());
      this.batchRowResultRepo.deleteByBatchId(batch.id);

      this.auditRepo.create({
        operationType: OperationType.READING_IMPORT,
        entityId: batch.id,
        entityType: 'import_batch',
        operator,
        details: `导入CSV文件"${fileName}"失败，事务已回滚。错误：${error instanceof Error ? error.message : String(error)}`,
        importBatchId: batch.id,
      });

      throw error;
    }

    this.auditRepo.create({
      operationType: OperationType.READING_IMPORT,
      entityId: batch.id,
      entityType: 'import_batch',
      operator,
      details: `导入CSV文件"${fileName}"，共${batch.totalCount}条，成功${validReadings.length}条，失败${errors.length}条，生成告警${generatedAlarms}条，恢复告警${recoveredAlarms}条`,
      importBatchId: batch.id,
    });

    return {
      batchId: batch.id,
      successCount: validReadings.length,
      failedCount: errors.length,
      errors,
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
