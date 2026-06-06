export enum DeviceStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive'
}

export enum AlarmStatus {
  OPEN = 'open',
  ACKNOWLEDGED = 'acknowledged',
  RECOVERED = 'recovered',
  CLOSED = 'closed'
}

export enum AlarmType {
  HIGH_TEMP = 'high_temp',
  LOW_TEMP = 'low_temp'
}

export enum OperationType {
  DEVICE_CREATE = 'device_create',
  DEVICE_UPDATE = 'device_update',
  THRESHOLD_SET = 'threshold_set',
  READING_IMPORT = 'reading_import',
  ALARM_ACKNOWLEDGE = 'alarm_acknowledge',
  ALARM_CLOSE = 'alarm_close',
  ALARM_RECOVER = 'alarm_recover'
}

export interface Device {
  id: string;
  name: string;
  storeId: string;
  storeName: string;
  status: DeviceStatus;
  createdAt: number;
  updatedAt: number;
}

export interface Threshold {
  id?: string;
  deviceId: string | null;
  storeId: string | null;
  isDefault: boolean;
  minTemp: number;
  maxTemp: number;
  createdAt: number;
  updatedAt: number;
}

export interface TemperatureReading {
  id?: string;
  deviceId: string;
  temperature: number;
  readingTime: number;
  importBatchId: string;
  createdAt: number;
}

export interface ImportBatch {
  id: string;
  fileName: string;
  totalCount: number;
  successCount: number;
  failedCount: number;
  errorDetails: string;
  createdAt: number;
  createdBy: string;
}

export interface Alarm {
  id: string;
  deviceId: string;
  type: AlarmType;
  threshold: number;
  readingId: string;
  readingTime: number;
  temperature: number;
  status: AlarmStatus;
  acknowledgedAt?: number;
  acknowledgedBy?: string;
  recoveredAt?: number;
  recoveredReadingId?: string;
  recoveredTemperature?: number;
  closedAt?: number;
  closedBy?: string;
  closeNote?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AuditLog {
  id?: string;
  operationType: OperationType;
  entityId: string;
  entityType: string;
  operator: string;
  details: string;
  storeId?: string;
  deviceId?: string;
  importBatchId?: string;
  alarmId?: string;
  createdAt: number;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  errors?: string[];
}

export interface QueryFilters {
  storeId?: string;
  deviceId?: string;
  alarmStatus?: AlarmStatus;
  importBatchId?: string;
  startTime?: number;
  endTime?: number;
  page?: number;
  pageSize?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ImportResult {
  batchId: string;
  successCount: number;
  failedCount: number;
  errors: string[];
  generatedAlarms: number;
  recoveredAlarms: number;
}

export interface CsvReadingRow {
  deviceId: string;
  temperature: string;
  readingTime: string;
}
