import { CsvReadingRow, TemperatureReading } from '../../types';
import { ValidationError, ConflictError, NotFoundError } from '../../utils/errors';
import { DeviceRepository, ReadingRepository } from '../../storage/repositories';

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
