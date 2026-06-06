import { Readable } from 'stream';
import csvParser from 'csv-parser';
import { runInTransaction } from '../../storage/database';
import {
  DeviceRepository,
  ReadingRepository,
  ImportBatchRepository,
  AuditRepository,
} from '../../storage/repositories';
import { AlarmService } from './AlarmService';
import { CsvReadingRow, ImportResult, OperationType, TemperatureReading } from '../../types';
import { validateImportRow, RowValidationContext, checkImportPermission } from '../rules';
import logger from '../../utils/logger';

export class ReadingImportService {

  constructor(
    private deviceRepo: DeviceRepository,
    private readingRepo: ReadingRepository,
    private importBatchRepo: ImportBatchRepository,
    private auditRepo: AuditRepository,
    private alarmService: AlarmService
  ) {}

  async importFromCsv(
    fileStream: Readable,
    fileName: string,
    operator: string
  ): Promise<ImportResult> {
    checkImportPermission(operator);

    const batch = this.importBatchRepo.create({
      fileName,
      totalCount: 0,
      successCount: 0,
      failedCount: 0,
      errorDetails: '',
      createdBy: operator,
    });

    const rows: CsvReadingRow[] = [];
    const errors: string[] = [];
    const context: RowValidationContext = {
      lastReadingTimes: new Map<string, number>(),
      rowIndex: 0,
    };

    await new Promise<void>((resolve, reject) => {
      fileStream
        .pipe(csvParser({ headers: ['deviceId', 'temperature', 'readingTime'], skipLines: 0 }))
        .on('data', (row: CsvReadingRow) => {
          context.rowIndex++;
          rows.push(row);
        })
        .on('end', resolve)
        .on('error', reject);
    });

    batch.totalCount = rows.length;

    const validReadings: Array<{
      reading: Omit<TemperatureReading, 'id' | 'createdAt'>;
      deviceId: string;
      storeId: string;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const currentContext: RowValidationContext = {
        ...context,
        rowIndex: i + 1,
      };

      const validation = await validateImportRow(row, currentContext, this.deviceRepo, this.readingRepo);

      if (!validation.valid || !validation.parsed) {
        errors.push(validation.error || `第${i + 1}行：未知错误`);
        continue;
      }

      const { deviceId, temperature, readingTime } = validation.parsed;
      context.lastReadingTimes.set(deviceId, readingTime);

      const device = this.deviceRepo.findById(deviceId)!;
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

        this.importBatchRepo.update(batch.id, {
          successCount: validReadings.length,
          failedCount: errors.length,
          errorDetails: errors.length > 0 ? JSON.stringify(errors) : '',
        });
      });
    } catch (error) {
      logger.error('Import transaction failed', error);
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
    };
  }

  async importFromCsvWithHeader(
    fileStream: Readable,
    fileName: string,
    operator: string
  ): Promise<ImportResult> {
    return this.importFromCsv(fileStream, fileName, operator);
  }
}
