import { z } from 'zod';
import { DeviceStatus, AlarmStatus, BatchStatus, RowStatus, RemarkStatus, EscalationRuleScope, EscalationRuleStatus, EscalationTicketStatus, CalibrationPlanStatus } from '../types';
import { getTestUsers } from '../domain/rules/authRules';

export const createDeviceSchema = z.object({
  id: z.string().min(1, '设备ID不能为空'),
  name: z.string().min(1, '设备名称不能为空'),
  storeId: z.string().min(1, '门店ID不能为空'),
  storeName: z.string().min(1, '门店名称不能为空'),
  status: z.enum([DeviceStatus.ACTIVE, DeviceStatus.INACTIVE]).default(DeviceStatus.ACTIVE),
});

export const updateDeviceSchema = z.object({
  name: z.string().min(1, '设备名称不能为空').optional(),
  storeId: z.string().min(1, '门店ID不能为空').optional(),
  storeName: z.string().min(1, '门店名称不能为空').optional(),
  status: z.enum([DeviceStatus.ACTIVE, DeviceStatus.INACTIVE]).optional(),
});

export const deviceIdSchema = z.object({
  id: z.string().min(1, '设备ID不能为空'),
});

export const deviceIdParamSchema = z.object({
  deviceId: z.string().min(1, '设备ID不能为空'),
});

const thresholdBaseSchema = z.object({
  minTemp: z.number().refine(v => !isNaN(v), '最低温度必须是数字'),
  maxTemp: z.number().refine(v => !isNaN(v), '最高温度必须是数字'),
});

export const thresholdSchema = thresholdBaseSchema.refine(data => data.minTemp < data.maxTemp, {
  message: '最低温度必须小于最高温度',
  path: ['minTemp'],
});

export const storeThresholdSchema = thresholdBaseSchema.extend({
  storeId: z.string().min(1, '门店ID不能为空'),
}).refine(data => data.minTemp < data.maxTemp, {
  message: '最低温度必须小于最高温度',
  path: ['minTemp'],
});

export const deviceThresholdSchema = thresholdBaseSchema.extend({
  deviceId: z.string().min(1, '设备ID不能为空'),
}).refine(data => data.minTemp < data.maxTemp, {
  message: '最低温度必须小于最高温度',
  path: ['minTemp'],
});

export const acknowledgeAlarmSchema = z.object({
  operator: z.string().min(1, '操作人不能为空'),
  note: z.string().optional(),
});

export const closeAlarmSchema = z.object({
  operator: z.string().min(1, '操作人不能为空'),
  note: z.string().min(1, '关闭备注不能为空'),
});

export const alarmIdSchema = z.object({
  id: z.string().min(1, '告警ID不能为空'),
});

export const queryFiltersSchema = z.object({
  storeId: z.string().optional(),
  deviceId: z.string().optional(),
  alarmStatus: z.enum([
    AlarmStatus.OPEN,
    AlarmStatus.ACKNOWLEDGED,
    AlarmStatus.RECOVERED,
    AlarmStatus.CLOSED,
  ]).optional(),
  importBatchId: z.string().optional(),
  startTime: z.coerce.number().optional(),
  endTime: z.coerce.number().optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(500).optional().default(50),
});

export const importCsvSchema = z.object({
  operator: z.string().min(1, '操作人不能为空'),
  idempotencyKey: z.string().optional(),
});

export const exportSchema = queryFiltersSchema.extend({
  format: z.enum(['csv', 'json']).default('csv'),
});

export const readingRowSchema = z.object({
  deviceId: z.string().min(1, '设备ID不能为空'),
  temperature: z.string().min(1, '温度不能为空'),
  readingTime: z.string().min(1, '读数时间不能为空'),
});

export const dryRunCsvSchema = z.object({
  operator: z.string().min(1, '操作人不能为空'),
});

const VALID_HANDLERS = getTestUsers().map(u => u.id);

const remarkFiltersBaseSchema = z.object({
  remarkStatus: z.enum([
    RemarkStatus.REMARKED,
    RemarkStatus.UNREMARKED,
  ]).optional(),
  handledBy: z.string().optional().refine(
    (val) => !val || VALID_HANDLERS.includes(val),
    { message: `处理人必须是已知用户: ${VALID_HANDLERS.join(', ')}` }
  ),
  remarkStartTime: z.coerce.number().optional().refine(
    (val) => val === undefined || val === null || (val > 946656000000 && val < 4102444800000),
    { message: 'remarkStartTime 必须是有效的时间戳（毫秒）' }
  ),
  remarkEndTime: z.coerce.number().optional().refine(
    (val) => val === undefined || val === null || (val > 946656000000 && val < 4102444800000),
    { message: 'remarkEndTime 必须是有效的时间戳（毫秒）' }
  ),
});

export const remarkFiltersSchema = remarkFiltersBaseSchema.refine(
  (data) => {
    if (data.remarkStartTime !== undefined && data.remarkStartTime !== null && 
        data.remarkEndTime !== undefined && data.remarkEndTime !== null) {
      return data.remarkStartTime <= data.remarkEndTime;
    }
    return true;
  },
  { message: 'remarkStartTime 不能大于 remarkEndTime', path: ['remarkStartTime'] }
).refine(
  (data) => {
    if (data.remarkStatus === 'unremarked' && (data.handledBy || data.remarkStartTime || data.remarkEndTime)) {
      return false;
    }
    return true;
  },
  { message: '筛选未备注行时不能同时指定处理人或处理时间范围', path: ['remarkStatus'] }
);

export const batchDetailSchema = remarkFiltersBaseSchema.extend({
  format: z.enum(['csv', 'json']).optional().default('json'),
  rowStatus: z.enum([
    RowStatus.PENDING,
    RowStatus.SUCCESS,
    RowStatus.FAILED,
    RowStatus.SKIPPED,
    'all',
  ]).optional().default('all'),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(500).optional().default(100),
}).refine(
  (data) => {
    if (data.remarkStartTime !== undefined && data.remarkStartTime !== null && 
        data.remarkEndTime !== undefined && data.remarkEndTime !== null) {
      return data.remarkStartTime <= data.remarkEndTime;
    }
    return true;
  },
  { message: 'remarkStartTime 不能大于 remarkEndTime', path: ['remarkStartTime'] }
).refine(
  (data) => {
    if (data.remarkStatus === 'unremarked' && (data.handledBy || data.remarkStartTime || data.remarkEndTime)) {
      return false;
    }
    return true;
  },
  { message: '筛选未备注行时不能同时指定处理人或处理时间范围', path: ['remarkStatus'] }
);

export const batchQueryFiltersSchema = queryFiltersSchema.merge(remarkFiltersBaseSchema).extend({
  batchStatus: z.enum([
    BatchStatus.PENDING,
    BatchStatus.PROCESSING,
    BatchStatus.COMPLETED,
    BatchStatus.FAILED,
    BatchStatus.ROLLED_BACK,
  ]).optional(),
  rowStatus: z.enum([
    RowStatus.PENDING,
    RowStatus.SUCCESS,
    RowStatus.FAILED,
    RowStatus.SKIPPED,
  ]).optional(),
}).refine(
  (data) => {
    if (data.remarkStartTime !== undefined && data.remarkStartTime !== null && 
        data.remarkEndTime !== undefined && data.remarkEndTime !== null) {
      return data.remarkStartTime <= data.remarkEndTime;
    }
    return true;
  },
  { message: 'remarkStartTime 不能大于 remarkEndTime', path: ['remarkStartTime'] }
).refine(
  (data) => {
    if (data.remarkStatus === 'unremarked' && (data.handledBy || data.remarkStartTime || data.remarkEndTime)) {
      return false;
    }
    return true;
  },
  { message: '筛选未备注行时不能同时指定处理人或处理时间范围', path: ['remarkStatus'] }
);

export const upsertRemarkSchema = z.object({
  remarkContent: z.string().max(1000, '备注内容不能超过1000字符'),
});

export const remarkRowParamSchema = z.object({
  batchId: z.string().min(1, '批次ID不能为空'),
  rowIndex: z.coerce.number().int().positive('行号必须是正整数'),
});

export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;
export type UpdateDeviceInput = z.infer<typeof updateDeviceSchema>;
export type ThresholdInput = z.infer<typeof thresholdSchema>;
export type StoreThresholdInput = z.infer<typeof storeThresholdSchema>;
export type DeviceThresholdInput = z.infer<typeof deviceThresholdSchema>;
export type AcknowledgeAlarmInput = z.infer<typeof acknowledgeAlarmSchema>;
export type CloseAlarmInput = z.infer<typeof closeAlarmSchema>;
export type QueryFiltersInput = z.infer<typeof queryFiltersSchema>;
export type ExportInput = z.infer<typeof exportSchema>;
export type ImportCsvInput = z.infer<typeof importCsvSchema>;
export type DryRunCsvInput = z.infer<typeof dryRunCsvSchema>;
export type BatchDetailInput = z.infer<typeof batchDetailSchema>;
export type BatchQueryFiltersInput = z.infer<typeof batchQueryFiltersSchema>;
export type BatchDetailFiltersInput = z.infer<typeof batchDetailSchema>;
export type UpsertRemarkInput = z.infer<typeof upsertRemarkSchema>;
export type RemarkRowParamInput = z.infer<typeof remarkRowParamSchema>;
export type RemarkFiltersInput = z.infer<typeof remarkFiltersSchema>;

const VALID_ESCALATION_ASSIGNEES = getTestUsers().map(u => u.id);

export const createEscalationRuleSchema = z.object({
  name: z.string().min(1, '规则名称不能为空').max(100, '规则名称不能超过100字符'),
  scope: z.enum([EscalationRuleScope.DEFAULT, EscalationRuleScope.STORE, EscalationRuleScope.DEVICE], {
    required_error: '必须指定规则范围',
  }),
  storeId: z.string().optional(),
  deviceId: z.string().optional(),
  acknowledgeTimeoutSeconds: z.coerce.number().int().positive('确认时限必须是正整数'),
  assigneeUserId: z.string().refine(
    (val) => VALID_ESCALATION_ASSIGNEES.includes(val),
    { message: `处理人必须是已知用户: ${VALID_ESCALATION_ASSIGNEES.join(', ')}` }
  ),
  operator: z.string().min(1, '操作人不能为空'),
}).refine(
  (data) => {
    if (data.scope === EscalationRuleScope.STORE && !data.storeId) {
      return false;
    }
    return true;
  },
  { message: '门店范围必须指定门店ID', path: ['storeId'] }
).refine(
  (data) => {
    if (data.scope === EscalationRuleScope.DEVICE && !data.deviceId) {
      return false;
    }
    return true;
  },
  { message: '设备范围必须指定设备ID', path: ['deviceId'] }
);

export const escalationRuleIdSchema = z.object({
  id: z.string().min(1, '规则ID不能为空'),
});

export const escalationTicketIdSchema = z.object({
  id: z.string().min(1, '升级单ID不能为空'),
});

export const escalationTicketClaimSchema = z.object({
  operator: z.string().min(1, '操作人不能为空'),
});

export const processOverdueSchema = z.object({
  operator: z.string().min(1, '操作人不能为空'),
  currentTime: z.coerce.number().optional(),
});

export const escalationFiltersSchema = z.object({
  ruleStatus: z.enum([
    EscalationRuleStatus.ACTIVE,
    EscalationRuleStatus.INACTIVE,
    EscalationRuleStatus.REVOKED,
  ]).optional(),
  ticketStatus: z.enum([
    EscalationTicketStatus.PENDING,
    EscalationTicketStatus.CLAIMED,
    EscalationTicketStatus.RESOLVED,
  ]).optional(),
  assigneeUserId: z.string().optional(),
  claimedBy: z.string().optional(),
  ruleId: z.string().optional(),
  storeId: z.string().optional(),
  deviceId: z.string().optional(),
  alarmId: z.string().optional(),
  startTime: z.coerce.number().optional(),
  endTime: z.coerce.number().optional(),
  format: z.enum(['csv', 'json']).default('csv'),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(500).optional().default(50),
});

export type CreateEscalationRuleInput = z.infer<typeof createEscalationRuleSchema>;
export type EscalationRuleIdInput = z.infer<typeof escalationRuleIdSchema>;
export type EscalationTicketIdInput = z.infer<typeof escalationTicketIdSchema>;
export type EscalationTicketClaimInput = z.infer<typeof escalationTicketClaimSchema>;
export type EscalationFiltersInput = z.infer<typeof escalationFiltersSchema>;

const VALID_CALIBRATION_OPERATORS = getTestUsers().map(u => u.id);

export const createCalibrationPlanSchema = z.object({
  deviceId: z.string().min(1, '设备ID不能为空'),
  offsetValue: z.coerce.number().refine(
    (v) => !isNaN(v) && v >= -50 && v <= 50,
    { message: '偏移值必须是-50到50之间的有效数字' }
  ),
  effectiveStartTime: z.coerce.number().refine(
    (v) => !isNaN(v) && v > 946656000000 && v < 4102444800000,
    { message: '生效开始时间必须是有效的时间戳（毫秒）' }
  ),
  effectiveEndTime: z.coerce.number().optional().refine(
    (v) => v === undefined || v === null || (!isNaN(v) && v > 946656000000 && v < 4102444800000),
    { message: '生效结束时间必须是有效的时间戳（毫秒）' }
  ),
  reason: z.string().min(1, '校准原因不能为空').max(500, '校准原因不能超过500字符'),
  personInCharge: z.string().refine(
    (val) => VALID_CALIBRATION_OPERATORS.includes(val),
    { message: `负责人必须是已知用户: ${VALID_CALIBRATION_OPERATORS.join(', ')}` }
  ),
  operator: z.string().min(1, '操作人不能为空'),
}).refine(
  (data) => {
    if (data.effectiveEndTime !== undefined && data.effectiveEndTime !== null) {
      return data.effectiveStartTime < data.effectiveEndTime;
    }
    return true;
  },
  { message: '生效开始时间必须早于生效结束时间', path: ['effectiveStartTime'] }
);

export const calibrationPlanIdSchema = z.object({
  id: z.string().min(1, '校准计划ID不能为空'),
});

export const calibrationFiltersSchema = z.object({
  planStatus: z.enum([
    CalibrationPlanStatus.ACTIVE,
    CalibrationPlanStatus.INACTIVE,
    CalibrationPlanStatus.REVOKED,
  ]).optional(),
  deviceId: z.string().optional(),
  storeId: z.string().optional(),
  startTime: z.coerce.number().optional(),
  endTime: z.coerce.number().optional(),
  format: z.enum(['csv', 'json']).default('csv'),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(500).optional().default(50),
});

export const calibrationDeactivateSchema = z.object({
  operator: z.string().min(1, '操作人不能为空'),
});

export const calibrationRevokeSchema = z.object({
  operator: z.string().min(1, '操作人不能为空'),
});

export type CreateCalibrationPlanInput = z.infer<typeof createCalibrationPlanSchema>;
export type CalibrationPlanIdInput = z.infer<typeof calibrationPlanIdSchema>;
export type CalibrationFiltersInput = z.infer<typeof calibrationFiltersSchema>;
export type CalibrationDeactivateInput = z.infer<typeof calibrationDeactivateSchema>;
export type CalibrationRevokeInput = z.infer<typeof calibrationRevokeSchema>;
