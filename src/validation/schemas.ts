import { z } from 'zod';
import { DeviceStatus, AlarmStatus, BatchStatus, RowStatus } from '../types';

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

export const batchDetailSchema = z.object({
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
});

export const batchQueryFiltersSchema = queryFiltersSchema.extend({
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
