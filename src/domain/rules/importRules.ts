import { CsvReadingRow, TemperatureReading, DryRunResult, AlarmType, Alarm, Threshold } from '../../types';
import { ValidationError, ConflictError, NotFoundError } from '../../utils/errors';
import { DeviceRepository, ReadingRepository, ThresholdRepository, AlarmRepository } from '../../storage/repositories';
import { checkThresholdViolation, findMatchingAlarmForRecovery, shouldCreateNewAlarm } from './alarmRules';

export interface ValidationResult {
  valid: boolean;
  error?: string;
  parsed?: {
    deviceId: string;
    temperature: number;
    readingTime: number;
  };
}

export interface ProcessedReading {
  originalRow: CsvReadingRow;
  rowIndex: number;
  validation: ValidationResult;
  reading?: TemperatureReading;
}

export function parseDateTime(dateStr: string): number | null {
  const trimmed = dateStr.trim();

  const formats = [
    (s: string) => {
      const match = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
      if (match) {
        const [, y, m, d, hh, mm, ss] = match;
        return new Date(+y, +m - 1, +d, +hh, +mm, +ss).getTime();
      }
      return null;
    },
    (s: string) => {
      const match = s.match(/^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
      if (match) {
        const [, y, m, d, hh, mm, ss] = match;
        return new Date(+y, +m - 1, +d, +hh, +mm, +ss).getTime();
      }
      return null;
    },
    (s: string) => {
      const ts = Date.parse(s);
      if (!isNaN(ts)) return ts;
      return null;
    },
    (s: string) => {
      const num = parseInt(s, 10);
      if (!isNaN(num) && num > 946656000000 && num < 4102444800000) {
        return num;
      }
      return null;
    },
  ];

  for (const parser of formats) {
    const result = parser(trimmed);
    if (result !== null) {
      return result;
    }
  }
  return null;
}

export function validateRowFormat(
  row: CsvReadingRow,
  rowIndex: number
): ValidationResult {
  if (!row.deviceId || row.deviceId.trim() === '') {
    return {
      valid: false,
      error: `第${rowIndex}行：设备ID不能为空`,
    };
  }

  if (!row.temperature || row.temperature.trim() === '') {
    return {
      valid: false,
      error: `第${rowIndex}行：温度不能为空`,
    };
  }

  const temp = parseFloat(row.temperature);
  if (isNaN(temp)) {
    return {
      valid: false,
      error: `第${rowIndex}行：温度"${row.temperature}"不是有效数字`,
    };
  }

  if (!row.readingTime || row.readingTime.trim() === '') {
    return {
      valid: false,
      error: `第${rowIndex}行：读数时间不能为空`,
    };
  }

  const readingTime = parseDateTime(row.readingTime);
  if (readingTime === null) {
    return {
      valid: false,
      error: `第${rowIndex}行：读数时间"${row.readingTime}"格式无效，支持YYYY-MM-DD HH:mm:ss、YYYY/MM/DD HH:mm:ss或ISO8601格式`,
    };
  }

  return {
    valid: true,
    parsed: {
      deviceId: row.deviceId.trim(),
      temperature: temp,
      readingTime,
    },
  };
}

export async function validateDeviceAndUniqueness(
  parsed: { deviceId: string; readingTime: number; temperature: number },
  rowIndex: number,
  deviceRepo: DeviceRepository,
  readingRepo: ReadingRepository
): Promise<ValidationResult> {
  const device = deviceRepo.findById(parsed.deviceId);
  if (!device) {
    return {
      valid: false,
      error: `第${rowIndex}行：设备"${parsed.deviceId}"不存在，请到设备台账中添加`,
    };
  }

  if (device.status !== 'active') {
    return {
      valid: false,
      error: `第${rowIndex}行：设备"${parsed.deviceId}"已停用，无法导入读数`,
    };
  }

  const exists = readingRepo.exists(parsed.deviceId, parsed.readingTime);
  if (exists) {
    const timeStr = new Date(parsed.readingTime).toLocaleString('zh-CN');
    return {
      valid: false,
      error: `第${rowIndex}行：设备"${parsed.deviceId}"在${timeStr}已有读数记录，重复数据`,
    };
  }

  return { valid: true, parsed };
}

export function checkChronologicalOrder(
  currentReadingTime: number,
  lastReadingTime: number | null,
  deviceId: string,
  rowIndex: number
): ValidationResult {
  if (lastReadingTime !== null && currentReadingTime < lastReadingTime) {
    const currentTime = new Date(currentReadingTime).toLocaleString('zh-CN');
    const lastTime = new Date(lastReadingTime).toLocaleString('zh-CN');
    return {
      valid: false,
      error: `第${rowIndex}行：设备"${deviceId}"读数时间倒序，当前时间${currentTime}早于上一条${lastTime}，请按时间升序排列`,
    };
  }
  return { valid: true };
}

export function validateTemperatureRange(temperature: number, rowIndex: number): ValidationResult {
  if (temperature < -100 || temperature > 100) {
    return {
      valid: false,
      error: `第${rowIndex}行：温度${temperature}℃超出合理范围(-100℃ ~ 100℃)`,
    };
  }
  return { valid: true };
}

export interface RowValidationContext {
  lastReadingTimes: Map<string, number>;
  rowIndex: number;
}

export function validateImportRow(
  row: CsvReadingRow,
  context: RowValidationContext,
  deviceRepo: DeviceRepository,
  readingRepo: ReadingRepository
): Promise<ValidationResult> {
  const { rowIndex } = context;

  const formatResult = validateRowFormat(row, rowIndex);
  if (!formatResult.valid || !formatResult.parsed) {
    return Promise.resolve(formatResult);
  }

  const { deviceId, temperature, readingTime } = formatResult.parsed;

  const tempResult = validateTemperatureRange(temperature, rowIndex);
  if (!tempResult.valid) {
    return Promise.resolve(tempResult);
  }

  const orderResult = checkChronologicalOrder(
    readingTime,
    context.lastReadingTimes.get(deviceId) || null,
    deviceId,
    rowIndex
  );
  if (!orderResult.valid) {
    return Promise.resolve(orderResult);
  }

  return validateDeviceAndUniqueness(
    { deviceId, temperature, readingTime },
    rowIndex,
    deviceRepo,
    readingRepo
  );
}

export interface PreCheckContext {
  lastReadingTimes: Map<string, number>;
  rowIndex: number;
  openAlarmsCache: Map<string, Alarm[]>;
  thresholdCache: Map<string, Threshold>;
}

export interface ValidatedRow {
  originalRow: CsvReadingRow;
  rowIndex: number;
  parsed?: {
    deviceId: string;
    temperature: number;
    readingTime: number;
  };
  valid: boolean;
  error?: string;
  deviceExists?: boolean;
  deviceActive?: boolean;
  isDuplicate?: boolean;
  isOutOfOrder?: boolean;
  temperatureValid?: boolean;
  threshold?: Threshold;
  thresholdViolation?: {
    violated: boolean;
    type?: AlarmType;
    thresholdValue?: number;
  };
}

export async function preCheckAndClassifyRow(
  row: CsvReadingRow,
  context: PreCheckContext,
  deviceRepo: DeviceRepository,
  readingRepo: ReadingRepository,
  thresholdRepo: ThresholdRepository,
  alarmRepo: AlarmRepository
): Promise<ValidatedRow> {
  const { rowIndex } = context;
  const result: ValidatedRow = {
    originalRow: row,
    rowIndex,
    valid: false,
  };

  const formatResult = validateRowFormat(row, rowIndex);
  if (!formatResult.valid || !formatResult.parsed) {
    result.error = formatResult.error;
    return result;
  }

  const { deviceId, temperature, readingTime } = formatResult.parsed;
  result.parsed = { deviceId, temperature, readingTime };

  const tempResult = validateTemperatureRange(temperature, rowIndex);
  if (!tempResult.valid) {
    result.error = tempResult.error;
    result.temperatureValid = false;
    return result;
  }
  result.temperatureValid = true;

  const orderResult = checkChronologicalOrder(
    readingTime,
    context.lastReadingTimes.get(deviceId) || null,
    deviceId,
    rowIndex
  );
  if (!orderResult.valid) {
    result.error = orderResult.error;
    result.isOutOfOrder = true;
    return result;
  }
  result.isOutOfOrder = false;

  const device = deviceRepo.findById(deviceId);
  result.deviceExists = !!device;
  if (!device) {
    result.error = `第${rowIndex}行：设备"${deviceId}"不存在，请到设备台账中添加`;
    return result;
  }

  result.deviceActive = device.status === 'active';
  if (device.status !== 'active') {
    result.error = `第${rowIndex}行：设备"${deviceId}"已停用，无法导入读数`;
    return result;
  }

  const exists = readingRepo.exists(deviceId, readingTime);
  result.isDuplicate = exists;
  if (exists) {
    const timeStr = new Date(readingTime).toLocaleString('zh-CN');
    result.error = `第${rowIndex}行：设备"${deviceId}"在${timeStr}已有读数记录，重复数据`;
    return result;
  }

  let threshold: Threshold;
  if (context.thresholdCache.has(deviceId)) {
    threshold = context.thresholdCache.get(deviceId)!;
  } else {
    threshold = thresholdRepo.findByDeviceIdWithFallback(deviceId, device.storeId);
    context.thresholdCache.set(deviceId, threshold);
  }
  result.threshold = threshold;

  const violation = checkThresholdViolation(temperature, threshold);
  result.thresholdViolation = violation;

  result.valid = true;
  context.lastReadingTimes.set(deviceId, readingTime);

  return result;
}

export async function performDryRun(
  rows: CsvReadingRow[],
  fileName: string,
  deviceRepo: DeviceRepository,
  readingRepo: ReadingRepository,
  thresholdRepo: ThresholdRepository,
  alarmRepo: AlarmRepository
): Promise<DryRunResult> {
  const context: PreCheckContext = {
    lastReadingTimes: new Map<string, number>(),
    rowIndex: 0,
    openAlarmsCache: new Map<string, Alarm[]>(),
    thresholdCache: new Map<string, Threshold>(),
  };

  const dryRunResult: DryRunResult = {
    fileName,
    totalCount: rows.length,
    validCount: 0,
    invalidCount: 0,
    newReadings: [],
    triggeredAlarms: [],
    recoveredAlarms: [],
    unknownDevices: [],
    inactiveDevices: [],
    duplicateTimes: [],
    outOfOrderTimes: [],
    thresholdConflicts: [],
    rowErrors: [],
  };

  const simulatedOpenAlarms = new Map<string, Alarm[]>();
  for (let i = 0; i < rows.length; i++) {
    context.rowIndex = i + 1;
    const row = rows[i];

    const validated = await preCheckAndClassifyRow(
      row,
      context,
      deviceRepo,
      readingRepo,
      thresholdRepo,
      alarmRepo
    );

    if (!validated.valid || !validated.parsed) {
      dryRunResult.invalidCount++;
      if (validated.error) {
        dryRunResult.rowErrors.push({
          rowIndex: context.rowIndex,
          error: validated.error,
        });
      }

      if (validated.deviceExists === false) {
        dryRunResult.unknownDevices.push({
          deviceId: row.deviceId,
          rowIndex: context.rowIndex,
        });
      } else if (validated.deviceActive === false) {
        dryRunResult.inactiveDevices.push({
          deviceId: row.deviceId,
          rowIndex: context.rowIndex,
        });
      }

      if (validated.isDuplicate) {
        dryRunResult.duplicateTimes.push({
          deviceId: row.deviceId,
          readingTime: validated.parsed?.readingTime || 0,
          rowIndex: context.rowIndex,
        });
      }

      if (validated.isOutOfOrder) {
        const prevTime = context.lastReadingTimes.get(row.deviceId) || 0;
        dryRunResult.outOfOrderTimes.push({
          deviceId: row.deviceId,
          currentTime: validated.parsed?.readingTime || 0,
          previousTime: prevTime,
          rowIndex: context.rowIndex,
        });
      }

      continue;
    }

    const { deviceId, temperature, readingTime } = validated.parsed;
    dryRunResult.validCount++;

    dryRunResult.newReadings.push({
      deviceId,
      temperature,
      readingTime,
      rowIndex: context.rowIndex,
    });

    const threshold = validated.threshold!;
    const violation = validated.thresholdViolation!;

    if (violation.violated) {
      dryRunResult.thresholdConflicts.push({
        deviceId,
        temperature,
        readingTime,
        minTemp: threshold.minTemp,
        maxTemp: threshold.maxTemp,
        violationType: violation.type === AlarmType.HIGH_TEMP ? 'above_max' : 'below_min',
        rowIndex: context.rowIndex,
      });

      let deviceOpenAlarms = simulatedOpenAlarms.get(deviceId);
      if (!deviceOpenAlarms) {
        deviceOpenAlarms = alarmRepo.findOpenByDevice(deviceId);
        simulatedOpenAlarms.set(deviceId, deviceOpenAlarms);
      }

      const mockReading = {
        id: 'mock-id',
        deviceId,
        temperature,
        readingTime,
        importBatchId: 'mock-batch',
        createdAt: Date.now(),
      };

      if (shouldCreateNewAlarm(mockReading, deviceOpenAlarms)) {
        dryRunResult.triggeredAlarms.push({
          deviceId,
          type: violation.type!,
          threshold: violation.thresholdValue!,
          temperature,
          readingTime,
          rowIndex: context.rowIndex,
        });

        const mockAlarm: Alarm = {
          id: 'mock-alarm',
          deviceId,
          type: violation.type!,
          threshold: violation.thresholdValue!,
          readingId: 'mock-reading',
          readingTime,
          temperature,
          status: 'open' as any,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        deviceOpenAlarms.push(mockAlarm);
      }
    } else {
      let deviceOpenAlarms = simulatedOpenAlarms.get(deviceId);
      if (!deviceOpenAlarms) {
        deviceOpenAlarms = alarmRepo.findOpenByDevice(deviceId);
        simulatedOpenAlarms.set(deviceId, deviceOpenAlarms);
      }

      const matchingAlarm = findMatchingAlarmForRecovery(
        temperature,
        deviceOpenAlarms,
        threshold
      );

      if (matchingAlarm) {
        dryRunResult.recoveredAlarms.push({
          alarmId: matchingAlarm.id,
          deviceId,
          type: matchingAlarm.type,
          originalTemperature: matchingAlarm.temperature,
          recoveredTemperature: temperature,
          recoveredReadingTime: readingTime,
          rowIndex: context.rowIndex,
        });

        const idx = deviceOpenAlarms.findIndex(a => a.id === matchingAlarm.id);
        if (idx !== -1) {
          deviceOpenAlarms[idx] = {
            ...deviceOpenAlarms[idx],
            status: 'recovered' as any,
            recoveredAt: Date.now(),
            recoveredTemperature: temperature,
          };
        }
      }
    }
  }

  return dryRunResult;
}
