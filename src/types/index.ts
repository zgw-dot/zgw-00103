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
  ALARM_RECOVER = 'alarm_recover',
  IDEMPOTENCY_HIT = 'idempotency_hit',
  IDEMPOTENCY_CONFLICT = 'idempotency_conflict',
  BATCH_ROW_REMARK_UPDATE = 'batch_row_remark_update',
  BATCH_ROW_REMARK_CLEAR = 'batch_row_remark_clear'
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
  status: BatchStatus;
  createdAt: number;
  createdBy: string;
  completedAt?: number;
  idempotencyKey?: string;
  fileContentHash?: string;
  isIdempotencyHit?: boolean;
  originalBatchId?: string;
  submitCount?: number;
}

export interface IdempotencyKeyRecord {
  id: string;
  idempotencyKey: string;
  operator: string;
  fileContentHash: string;
  originalBatchId: string;
  submitCount: number;
  createdAt: number;
  lastSubmitAt: number;
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
  code?: string;
  data?: T;
  message?: string;
  errors?: string[];
}

export const RemarkStatus = {
  REMARKED: 'remarked',
  UNREMARKED: 'unremarked',
} as const;

export type RemarkStatus = typeof RemarkStatus[keyof typeof RemarkStatus];

export interface RemarkFilters {
  remarkStatus?: RemarkStatus;
  handledBy?: string;
  remarkStartTime?: number;
  remarkEndTime?: number;
}

export interface DispositionStats {
  totalFailedRows: number;
  remarkedRows: number;
  unremarkedRows: number;
  byHandler: Array<{
    handledBy: string;
    count: number;
  }>;
  remarkProgress: number;
}

export interface BatchListDispositionStats {
  totalBatches: number;
  batchesWithUnremarkedRows: number;
  totalFailedRows: number;
  totalRemarkedRows: number;
  totalUnremarkedRows: number;
  overallProgress: number;
}

export interface QueryFilters extends RemarkFilters {
  storeId?: string;
  deviceId?: string;
  alarmStatus?: AlarmStatus;
  importBatchId?: string;
  startTime?: number;
  endTime?: number;
  page?: number;
  pageSize?: number;
  batchStatus?: BatchStatus;
  rowStatus?: RowStatus;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export enum BatchStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  ROLLED_BACK = 'rolled_back',
}

export enum RowStatus {
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

export interface DryRunResult {
  fileName: string;
  totalCount: number;
  validCount: number;
  invalidCount: number;
  newReadings: Array<{
    deviceId: string;
    temperature: number;
    readingTime: number;
    rowIndex: number;
  }>;
  triggeredAlarms: Array<{
    deviceId: string;
    type: AlarmType;
    threshold: number;
    temperature: number;
    readingTime: number;
    rowIndex: number;
  }>;
  recoveredAlarms: Array<{
    alarmId: string;
    deviceId: string;
    type: AlarmType;
    originalTemperature: number;
    recoveredTemperature: number;
    recoveredReadingTime: number;
    rowIndex: number;
  }>;
  unknownDevices: Array<{
    deviceId: string;
    rowIndex: number;
  }>;
  inactiveDevices: Array<{
    deviceId: string;
    rowIndex: number;
  }>;
  duplicateTimes: Array<{
    deviceId: string;
    readingTime: number;
    rowIndex: number;
  }>;
  outOfOrderTimes: Array<{
    deviceId: string;
    currentTime: number;
    previousTime: number;
    rowIndex: number;
  }>;
  thresholdConflicts: Array<{
    deviceId: string;
    temperature: number;
    readingTime: number;
    minTemp: number;
    maxTemp: number;
    violationType: 'above_max' | 'below_min';
    rowIndex: number;
  }>;
  rowErrors: Array<{
    rowIndex: number;
    error: string;
  }>;
}

export interface ImportResult {
  batchId: string;
  successCount: number;
  failedCount: number;
  errors: string[];
  generatedAlarms: number;
  recoveredAlarms: number;
  status: BatchStatus;
  idempotencyKey?: string;
  isIdempotencyHit?: boolean;
  originalBatchId?: string;
  submitCount?: number;
}

export interface BatchRowResult {
  id?: string;
  importBatchId: string;
  rowIndex: number;
  deviceId: string;
  temperature?: number;
  readingTime?: number;
  status: RowStatus;
  errorMessage?: string;
  createdAt?: number;
}

export interface BatchDetail {
  batch: ImportBatch;
  rowResults: BatchRowResult[];
  alarms: Alarm[];
  auditLogs: AuditLog[];
}

export interface PaginatedBatchDetail {
  batch: ImportBatch;
  rowResults: PaginatedResult<BatchRowResult>;
  alarms: Alarm[];
  auditLogs: AuditLog[];
}

export interface BatchDetailFilters extends RemarkFilters {
  rowStatus?: RowStatus | 'all';
  page?: number;
  pageSize?: number;
}

export interface CsvReadingRow {
  deviceId: string;
  temperature: string;
  readingTime: string;
}

export interface BatchRowRemark {
  id?: string;
  importBatchId: string;
  rowIndex: number;
  remarkContent: string;
  handledBy: string;
  handledAt: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface BatchRowRemarkStats {
  totalFailedRows: number;
  remarkedRows: number;
  unremarkedRows: number;
}

export interface BatchRowRemarkWithDispositionStats extends BatchRowRemarkStats {
  dispositionStats: DispositionStats;
}

export interface BatchRowResultWithRemark extends BatchRowResult {
  remark?: BatchRowRemark | null;
}

export interface BatchDetailWithRemarks {
  batch: ImportBatch & { remarkStats: BatchRowRemarkStats };
  dispositionStats: DispositionStats;
  rowResults: PaginatedResult<BatchRowResultWithRemark>;
  alarms: Alarm[];
  auditLogs: AuditLog[];
  appliedFilters: RemarkFilters;
}

export interface BatchDetailAllRowsWithRemarks {
  batch: ImportBatch & { remarkStats: BatchRowRemarkStats };
  dispositionStats: DispositionStats;
  rowResults: BatchRowResultWithRemark[];
  alarms: Alarm[];
  auditLogs: AuditLog[];
  appliedFilters: RemarkFilters;
}

export interface PaginatedBatchListWithDisposition {
  items: Array<ImportBatch & { remarkStats: BatchRowRemarkStats; dispositionStats: DispositionStats }>;
  total: number;
  page: number;
  pageSize: number;
  summary: BatchListDispositionStats;
  appliedFilters: RemarkFilters;
}

export interface UpsertRemarkInput {
  rowIndex: number;
  remarkContent: string;
}

export interface UpsertRemarkResult {
  remark: BatchRowRemark;
  isNew: boolean;
  isClear: boolean;
}
