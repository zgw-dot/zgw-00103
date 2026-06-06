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
  BATCH_ROW_REMARK_CLEAR = 'batch_row_remark_clear',
  ESCALATION_RULE_CREATE = 'escalation_rule_create',
  ESCALATION_RULE_DEACTIVATE = 'escalation_rule_deactivate',
  ESCALATION_RULE_REVOKE = 'escalation_rule_revoke',
  ESCALATION_TICKET_CREATE = 'escalation_ticket_create',
  ESCALATION_TICKET_CLAIM = 'escalation_ticket_claim',
  CALIBRATION_PLAN_CREATE = 'calibration_plan_create',
  CALIBRATION_PLAN_DEACTIVATE = 'calibration_plan_deactivate',
  CALIBRATION_PLAN_REVOKE = 'calibration_plan_revoke',
  READING_CORRECTION_APPLY = 'reading_correction_apply',
  INSPECTION_TEMPLATE_CREATE = 'inspection_template_create',
  INSPECTION_TEMPLATE_PUBLISH = 'inspection_template_publish',
  INSPECTION_TEMPLATE_CLOSE = 'inspection_template_close',
  INSPECTION_TEMPLATE_REVOKE = 'inspection_template_revoke',
  INSPECTION_SUBMIT = 'inspection_submit',
  INSPECTION_EXPORT = 'inspection_export'
}

export enum InspectionTemplateStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  CLOSED = 'closed',
  REVOKED = 'revoked'
}

export enum InspectionShift {
  MORNING = 'morning',
  AFTERNOON = 'afternoon',
  EVENING = 'evening',
  NIGHT = 'night'
}

export enum InspectionStatus {
  PENDING = 'pending',
  SUBMITTED = 'submitted',
  LATE = 'late',
  MISSED = 'missed'
}

export interface InspectionTimeWindow {
  startTime: string;
  endTime: string;
}

export interface InspectionPhotoRequirement {
  minCount: number;
  required: boolean;
}

export interface InspectionRemarkRequirement {
  minLength: number;
  required: boolean;
}

export interface InspectionTemplateDevice {
  deviceId: string;
  timeWindow: InspectionTimeWindow;
  photoRequirement: InspectionPhotoRequirement;
  remarkRequirement: InspectionRemarkRequirement;
  personInCharge: string;
  sortOrder: number;
}

export interface InspectionTemplate {
  id: string;
  name: string;
  storeId: string;
  storeName: string;
  shift: InspectionShift;
  date: number;
  devices: InspectionTemplateDevice[];
  status: InspectionTemplateStatus;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  publishedAt?: number;
  publishedBy?: string;
  closedAt?: number;
  closedBy?: string;
  closedReason?: string;
  revokedAt?: number;
  revokedBy?: string;
  revokedReason?: string;
}

export interface InspectionRecord {
  id: string;
  templateId: string;
  deviceId: string;
  storeId: string;
  submittedBy: string;
  submittedAt: number;
  status: InspectionStatus;
  photos: string[];
  remark: string;
  latestReadingId?: string;
  latestReadingTemperature?: number;
  latestReadingTime?: number;
  activeAlarmId?: string;
  activeAlarmType?: string;
  activeAlarmTemperature?: number;
  activeAlarmThreshold?: number;
  timeWindowStart?: number;
  timeWindowEnd?: number;
  expectedCheckTime?: number;
  isLate: boolean;
  lateMinutes?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateInspectionTemplateInput {
  name: string;
  storeId: string;
  storeName: string;
  shift: InspectionShift;
  date: number;
  devices: InspectionTemplateDevice[];
}

export interface PublishInspectionTemplateInput {
  reason?: string;
}

export interface CloseInspectionTemplateInput {
  reason: string;
}

export interface RevokeInspectionTemplateInput {
  reason: string;
}

export interface SubmitInspectionInput {
  templateId: string;
  deviceId: string;
  photos: string[];
  remark: string;
}

export interface InspectionFilters extends QueryFilters {
  templateStatus?: InspectionTemplateStatus;
  inspectionStatus?: InspectionStatus;
  shift?: InspectionShift;
  templateId?: string;
  submittedBy?: string;
  personInCharge?: string;
}

export interface InspectionExportFilters extends InspectionFilters {
  format?: 'csv' | 'json';
  type?: 'templates' | 'records';
}

export interface InspectionStats {
  totalTemplates: number;
  publishedTemplates: number;
  closedTemplates: number;
  revokedTemplates: number;
  totalInspections: number;
  submittedInspections: number;
  lateInspections: number;
  missedInspections: number;
  pendingInspections: number;
}

export interface InspectionTemplateWithDetails extends InspectionTemplate {
  inspectionCount: number;
  submittedCount: number;
  lateCount: number;
  missedCount: number;
}

export interface InspectionRecordWithDetails extends InspectionRecord {
  templateName: string;
  shift: InspectionShift;
  templateDate: number;
  deviceName: string;
  personInCharge: string;
  photoRequirement: InspectionPhotoRequirement;
  remarkRequirement: InspectionRemarkRequirement;
}

export enum CalibrationPlanStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  REVOKED = 'revoked'
}

export enum EscalationRuleStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  REVOKED = 'revoked'
}

export enum EscalationRuleScope {
  DEFAULT = 'default',
  STORE = 'store',
  DEVICE = 'device'
}

export enum EscalationTicketStatus {
  PENDING = 'pending',
  CLAIMED = 'claimed',
  RESOLVED = 'resolved'
}

export interface CalibrationPlan {
  id: string;
  deviceId: string;
  storeId: string;
  offsetValue: number;
  effectiveStartTime: number;
  effectiveEndTime: number | null;
  reason: string;
  personInCharge: string;
  status: CalibrationPlanStatus;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  deactivatedAt?: number;
  deactivatedBy?: string;
  revokedAt?: number;
  revokedBy?: string;
}

export interface ReadingCorrection {
  id: string;
  readingId: string;
  deviceId: string;
  calibrationPlanId: string;
  originalTemperature: number;
  correctedTemperature: number;
  offsetValue: number;
  readingTime: number;
  importBatchId: string;
  createdAt: number;
}

export interface CreateCalibrationPlanInput {
  deviceId: string;
  offsetValue: number;
  effectiveStartTime: number;
  effectiveEndTime?: number;
  reason: string;
  personInCharge: string;
}

export interface CalibrationFilters extends QueryFilters {
  planStatus?: CalibrationPlanStatus;
  deviceId?: string;
  storeId?: string;
}

export interface CalibrationApplyResult {
  planId: string;
  planName: string;
  offsetValue: number;
  originalTemperature: number;
  correctedTemperature: number;
}

export interface EscalationRule {
  id: string;
  name: string;
  scope: EscalationRuleScope;
  storeId: string | null;
  deviceId: string | null;
  acknowledgeTimeoutSeconds: number;
  assigneeUserId: string;
  status: EscalationRuleStatus;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  deactivatedAt?: number;
  deactivatedBy?: string;
  revokedAt?: number;
  revokedBy?: string;
}

export interface EscalationTicket {
  id: string;
  alarmId: string;
  ruleId: string;
  status: EscalationTicketStatus;
  assigneeUserId: string;
  claimedBy?: string;
  claimedAt?: number;
  escalatedAt: number;
  resolvedAt?: number;
  resolvedBy?: string;
  resolutionNote?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AlarmWithEscalation extends Alarm {
  escalationStatus?: EscalationTicketStatus | null;
  escalationTicketId?: string | null;
  escalationRuleName?: string | null;
  escalationAssignee?: string | null;
  escalationClaimedBy?: string | null;
  escalationEscalatedAt?: number | null;
}

export interface CreateEscalationRuleInput {
  name: string;
  scope: EscalationRuleScope;
  storeId?: string;
  deviceId?: string;
  acknowledgeTimeoutSeconds: number;
  assigneeUserId: string;
}

export interface EscalationFilters extends QueryFilters {
  ruleStatus?: EscalationRuleStatus;
  ticketStatus?: EscalationTicketStatus;
  assigneeUserId?: string;
  claimedBy?: string;
  ruleId?: string;
  alarmId?: string;
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
  originalTemperature: number;
  correctedTemperature: number;
  calibrationPlanId: string | null;
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
  originalTemperature: number;
  calibrationPlanId: string | null;
  status: AlarmStatus;
  acknowledgedAt?: number;
  acknowledgedBy?: string;
  recoveredAt?: number;
  recoveredReadingId?: string;
  recoveredTemperature?: number;
  recoveredOriginalTemperature?: number;
  recoveredCalibrationPlanId?: string | null;
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
  originalTemperature?: number;
  correctedTemperature?: number;
  calibrationPlanId?: string | null;
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
