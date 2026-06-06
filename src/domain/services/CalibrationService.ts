import {
  CalibrationPlanRepository,
  ReadingCorrectionRepository,
  DeviceRepository,
  AuditRepository,
} from '../../storage/repositories';
import {
  CalibrationPlan,
  CalibrationPlanStatus,
  ReadingCorrection,
  CreateCalibrationPlanInput,
  CalibrationFilters,
  PaginatedResult,
  OperationType,
  Device,
} from '../../types';
import {
  NotFoundError,
  ConflictError,
  ValidationError,
  BusinessError,
} from '../../utils/errors';
import {
  getTestUsers,
  checkManageCalibrationPlansPermission,
  checkViewCalibrationPlansPermission,
  checkExportCalibrationPermission,
} from '../rules';
import logger from '../../utils/logger';

export interface CalibrationApplyResult {
  plan: CalibrationPlan | null;
  originalTemperature: number;
  correctedTemperature: number;
  offsetApplied: number;
}

export class CalibrationService {
  constructor(
    private calibrationPlanRepo: CalibrationPlanRepository,
    private readingCorrectionRepo: ReadingCorrectionRepository,
    private deviceRepo: DeviceRepository,
    private auditRepo: AuditRepository
  ) {}

  createPlan(input: CreateCalibrationPlanInput, operator: string): CalibrationPlan {
    checkManageCalibrationPlansPermission(operator);

    this.validatePlanInput(input);

    const device = this.deviceRepo.findById(input.deviceId);
    if (!device) {
      throw new ValidationError(
        `设备"${input.deviceId}"不存在`,
        'deviceId',
        { deviceId: input.deviceId }
      );
    }

    if (device.status !== 'active') {
      throw new ValidationError(
        `设备"${input.deviceId}"已停用，不能创建校准计划`,
        'deviceId',
        { deviceId: input.deviceId, deviceStatus: device.status }
      );
    }

    if (this.calibrationPlanRepo.existsActiveForDeviceAtTime(
      input.deviceId,
      input.effectiveStartTime,
      input.effectiveEndTime ?? null
    )) {
      const overlapping = this.calibrationPlanRepo.findOverlappingPlans(
        input.deviceId,
        input.effectiveStartTime,
        input.effectiveEndTime ?? null
      );
      const overlapDesc = overlapping.map(p =>
        `计划ID: ${p.id}, 时间范围: ${new Date(p.effectiveStartTime).toLocaleString('zh-CN')} ~ ${p.effectiveEndTime ? new Date(p.effectiveEndTime).toLocaleString('zh-CN') : '永久'}`
      ).join('; ');
      throw new ConflictError(
        `设备"${input.deviceId}"在指定时间段内已存在生效的校准计划，时间段重叠。重叠计划: ${overlapDesc}`,
        {
          deviceId: input.deviceId,
          effectiveStartTime: input.effectiveStartTime,
          effectiveEndTime: input.effectiveEndTime,
          overlappingPlans: overlapping.map(p => ({ id: p.id, effectiveStartTime: p.effectiveStartTime, effectiveEndTime: p.effectiveEndTime }))
        }
      );
    }

    const validUsers = getTestUsers().map(u => u.id);
    if (!validUsers.includes(input.personInCharge)) {
      throw new ValidationError(
        `负责人"${input.personInCharge}"不存在，有效的负责人包括：${validUsers.join(', ')}`,
        'personInCharge',
        { value: input.personInCharge, validUsers }
      );
    }

    const plan = this.calibrationPlanRepo.create({
      deviceId: input.deviceId,
      storeId: device.storeId,
      offsetValue: input.offsetValue,
      effectiveStartTime: input.effectiveStartTime,
      effectiveEndTime: input.effectiveEndTime ?? null,
      reason: input.reason,
      personInCharge: input.personInCharge,
      createdBy: operator,
    });

    this.auditRepo.create({
      operationType: OperationType.CALIBRATION_PLAN_CREATE,
      entityId: plan.id,
      entityType: 'calibration_plan',
      operator,
      details: `创建设备校准计划：设备${input.deviceId}，偏移值${input.offsetValue}℃，生效时间：${new Date(input.effectiveStartTime).toLocaleString('zh-CN')} ~ ${input.effectiveEndTime ? new Date(input.effectiveEndTime).toLocaleString('zh-CN') : '永久'}，原因：${input.reason}，负责人：${input.personInCharge}`,
      deviceId: input.deviceId,
      storeId: device.storeId,
    });

    return plan;
  }

  deactivatePlan(planId: string, operator: string): CalibrationPlan {
    checkManageCalibrationPlansPermission(operator);

    const plan = this.getPlan(planId);
    if (plan.status !== CalibrationPlanStatus.ACTIVE) {
      throw new ConflictError(
        `校准计划"${planId}"当前状态为"${plan.status}"，无法停用`,
        { planId, currentStatus: plan.status }
      );
    }

    const now = Date.now();
    const updated = this.calibrationPlanRepo.updateStatus(
      planId,
      CalibrationPlanStatus.INACTIVE,
      {
        deactivatedAt: now,
        deactivatedBy: operator,
      }
    );

    if (!updated) {
      throw new ConflictError(`校准计划"${planId}"停用失败`, { planId });
    }

    this.auditRepo.create({
      operationType: OperationType.CALIBRATION_PLAN_DEACTIVATE,
      entityId: planId,
      entityType: 'calibration_plan',
      operator,
      details: `停用校准计划：${planId}，设备${plan.deviceId}，历史校准结果保持不变`,
      deviceId: plan.deviceId,
      storeId: plan.storeId,
    });

    return updated;
  }

  revokePlan(planId: string, operator: string): CalibrationPlan {
    checkManageCalibrationPlansPermission(operator);

    const plan = this.getPlan(planId);
    if (plan.status === CalibrationPlanStatus.REVOKED) {
      throw new ConflictError(
        `校准计划"${planId}"已被撤销，无需重复操作`,
        { planId }
      );
    }

    const now = Date.now();
    const updated = this.calibrationPlanRepo.updateStatus(
      planId,
      CalibrationPlanStatus.REVOKED,
      {
        revokedAt: now,
        revokedBy: operator,
      }
    );

    if (!updated) {
      throw new ConflictError(`校准计划"${planId}"撤销失败`, { planId });
    }

    const correctionCount = this.readingCorrectionRepo.findByCalibrationPlanId(planId, { pageSize: 1 }).total;

    this.auditRepo.create({
      operationType: OperationType.CALIBRATION_PLAN_REVOKE,
      entityId: planId,
      entityType: 'calibration_plan',
      operator,
      details: `撤销校准计划：${planId}，设备${plan.deviceId}，已应用该计划的${correctionCount}条历史读数修正结果保持不变`,
      deviceId: plan.deviceId,
      storeId: plan.storeId,
    });

    return updated;
  }

  getPlan(planId: string): CalibrationPlan {
    const plan = this.calibrationPlanRepo.findById(planId);
    if (!plan) {
      throw new NotFoundError(`校准计划"${planId}"不存在`, { planId });
    }
    return plan;
  }

  listPlans(filters: CalibrationFilters = {}, operator: string): PaginatedResult<CalibrationPlan> {
    checkViewCalibrationPlansPermission(operator);
    return this.calibrationPlanRepo.findAll(filters);
  }

  getCorrectionsForPlan(planId: string, filters: CalibrationFilters = {}, operator: string): PaginatedResult<ReadingCorrection> {
    checkViewCalibrationPlansPermission(operator);
    this.getPlan(planId);
    return this.readingCorrectionRepo.findByCalibrationPlanId(planId, filters);
  }

  getCorrectionsForBatch(batchId: string, operator: string): ReadingCorrection[] {
    checkViewCalibrationPlansPermission(operator);
    return this.readingCorrectionRepo.findByBatchId(batchId);
  }

  listCorrections(filters: CalibrationFilters = {}, operator: string): PaginatedResult<ReadingCorrection> {
    checkViewCalibrationPlansPermission(operator);
    return this.readingCorrectionRepo.findAll(filters);
  }

  applyCalibration(
    deviceId: string,
    readingTime: number,
    originalTemperature: number,
    deviceStoreId: string
  ): CalibrationApplyResult {
    const plan = this.calibrationPlanRepo.findActiveForDeviceAtTime(deviceId, readingTime);

    if (!plan) {
      return {
        plan: null,
        originalTemperature,
        correctedTemperature: originalTemperature,
        offsetApplied: 0,
      };
    }

    if (plan.storeId !== deviceStoreId) {
      logger.warn(`校准计划门店不匹配：计划门店${plan.storeId}，设备门店${deviceStoreId}，设备${deviceId}`, {
        planId: plan.id,
        planStoreId: plan.storeId,
        deviceStoreId,
        deviceId,
      });
      throw new BusinessError(
        `校准计划"${plan.id}"的门店(${plan.storeId})与设备"${deviceId}"的门店(${deviceStoreId})不匹配，无法应用校准`,
        'CALIBRATION_STORE_MISMATCH',
        { planId: plan.id, planStoreId: plan.storeId, deviceId, deviceStoreId }
      );
    }

    const correctedTemperature = Math.round((originalTemperature + plan.offsetValue) * 100) / 100;

    return {
      plan,
      originalTemperature,
      correctedTemperature,
      offsetApplied: plan.offsetValue,
    };
  }

  createCorrection(
    readingId: string,
    deviceId: string,
    calibrationPlanId: string,
    originalTemperature: number,
    correctedTemperature: number,
    offsetValue: number,
    readingTime: number,
    importBatchId: string
  ): ReadingCorrection {
    return this.readingCorrectionRepo.create({
      readingId,
      deviceId,
      calibrationPlanId,
      originalTemperature,
      correctedTemperature,
      offsetValue,
      readingTime,
      importBatchId,
    });
  }

  exportToCsv(filters: CalibrationFilters = {}, operator: string): string {
    checkExportCalibrationPermission(operator);

    const plans = this.calibrationPlanRepo.findAll({ ...filters, pageSize: 10000 }).items;
    const enrichedPlans = plans.map(plan => {
      const device = this.deviceRepo.findById(plan.deviceId);
      const correctionCount = this.readingCorrectionRepo.findByCalibrationPlanId(plan.id, { pageSize: 1 }).total;
      return { plan, device, correctionCount };
    });

    const headers = [
      '计划ID', '设备ID', '设备名称', '门店ID', '门店名称',
      '偏移值(℃)', '生效开始时间', '生效结束时间', '原因', '负责人',
      '状态', '创建人', '创建时间', '停用时间', '停用人',
      '撤销时间', '撤销人', '已应用修正次数'
    ];

    const rows = enrichedPlans.map(({ plan, device, correctionCount }) => [
      plan.id,
      plan.deviceId,
      device?.name || '',
      plan.storeId,
      device?.storeName || '',
      plan.offsetValue,
      new Date(plan.effectiveStartTime).toLocaleString('zh-CN'),
      plan.effectiveEndTime ? new Date(plan.effectiveEndTime).toLocaleString('zh-CN') : '永久',
      `"${plan.reason.replace(/"/g, '""')}"`,
      plan.personInCharge,
      this.getPlanStatusText(plan.status),
      plan.createdBy,
      new Date(plan.createdAt).toLocaleString('zh-CN'),
      plan.deactivatedAt ? new Date(plan.deactivatedAt).toLocaleString('zh-CN') : '',
      plan.deactivatedBy || '',
      plan.revokedAt ? new Date(plan.revokedAt).toLocaleString('zh-CN') : '',
      plan.revokedBy || '',
      correctionCount,
    ]);

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  exportCorrectionsToCsv(filters: CalibrationFilters = {}, operator: string): string {
    checkExportCalibrationPermission(operator);

    const corrections = this.readingCorrectionRepo.findAll({ ...filters, pageSize: 10000 }).items;
    const enriched = corrections.map(correction => {
      const plan = this.calibrationPlanRepo.findById(correction.calibrationPlanId);
      const device = this.deviceRepo.findById(correction.deviceId);
      return { correction, plan, device };
    });

    const headers = [
      '修正ID', '读数ID', '设备ID', '设备名称', '校准计划ID',
      '原始温度(℃)', '修正后温度(℃)', '偏移值(℃)', '读数时间',
      '导入批次ID', '创建时间'
    ];

    const rows = enriched.map(({ correction, plan, device }) => [
      correction.id,
      correction.readingId,
      correction.deviceId,
      device?.name || '',
      correction.calibrationPlanId,
      correction.originalTemperature,
      correction.correctedTemperature,
      correction.offsetValue,
      new Date(correction.readingTime).toLocaleString('zh-CN'),
      correction.importBatchId,
      new Date(correction.createdAt).toLocaleString('zh-CN'),
    ]);

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  exportToJson(filters: CalibrationFilters = {}, operator: string): string {
    checkExportCalibrationPermission(operator);

    const plans = this.calibrationPlanRepo.findAll({ ...filters, pageSize: 10000 }).items;
    const enriched = plans.map(plan => {
      const device = this.deviceRepo.findById(plan.deviceId);
      const correctionCount = this.readingCorrectionRepo.findByCalibrationPlanId(plan.id, { pageSize: 1 }).total;
      return {
        ...plan,
        deviceName: device?.name,
        storeName: device?.storeName,
        correctionCount,
      };
    });

    return JSON.stringify(enriched, null, 2);
  }

  exportCorrectionsToJson(filters: CalibrationFilters = {}, operator: string): string {
    checkExportCalibrationPermission(operator);

    const corrections = this.readingCorrectionRepo.findAll({ ...filters, pageSize: 10000 }).items;
    const enriched = corrections.map(correction => {
      const plan = this.calibrationPlanRepo.findById(correction.calibrationPlanId);
      const device = this.deviceRepo.findById(correction.deviceId);
      return {
        ...correction,
        deviceName: device?.name,
        planReason: plan?.reason,
      };
    });

    return JSON.stringify(enriched, null, 2);
  }

  export(
    filters: CalibrationFilters & { format?: 'csv' | 'json'; type?: 'plans' | 'corrections' },
    operator: string
  ): { content: string; contentType: string; filename: string } {
    const format = filters.format || 'csv';
    const type = filters.type || 'plans';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (type === 'corrections') {
      if (format === 'json') {
        return {
          content: this.exportCorrectionsToJson(filters, operator),
          contentType: 'application/json; charset=utf-8',
          filename: `reading_corrections_${timestamp}.json`,
        };
      }
      return {
        content: this.exportCorrectionsToCsv(filters, operator),
        contentType: 'text/csv; charset=utf-8',
        filename: `reading_corrections_${timestamp}.csv`,
      };
    }

    if (format === 'json') {
      return {
        content: this.exportToJson(filters, operator),
        contentType: 'application/json; charset=utf-8',
        filename: `calibration_plans_${timestamp}.json`,
      };
    }

    return {
      content: this.exportToCsv(filters, operator),
      contentType: 'text/csv; charset=utf-8',
      filename: `calibration_plans_${timestamp}.csv`,
    };
  }

  private validatePlanInput(input: CreateCalibrationPlanInput): void {
    if (!input.deviceId || input.deviceId.trim().length === 0) {
      throw new ValidationError('设备ID不能为空', 'deviceId');
    }

    if (isNaN(input.offsetValue)) {
      throw new ValidationError('偏移值必须是有效数字', 'offsetValue', { value: input.offsetValue });
    }

    if (input.offsetValue < -50 || input.offsetValue > 50) {
      throw new ValidationError(
        '偏移值必须在-50到50之间',
        'offsetValue',
        { value: input.offsetValue, min: -50, max: 50 }
      );
    }

    if (input.effectiveEndTime !== undefined && input.effectiveEndTime !== null) {
      if (input.effectiveStartTime >= input.effectiveEndTime) {
        throw new ValidationError(
          '生效开始时间必须早于生效结束时间',
          'effectiveStartTime',
          { effectiveStartTime: input.effectiveStartTime, effectiveEndTime: input.effectiveEndTime }
        );
      }
    }

    if (!input.reason || input.reason.trim().length === 0) {
      throw new ValidationError('校准原因不能为空', 'reason');
    }

    if (input.reason.length > 500) {
      throw new ValidationError('校准原因不能超过500字符', 'reason', { length: input.reason.length, max: 500 });
    }
  }

  private getPlanStatusText(status: CalibrationPlanStatus): string {
    switch (status) {
      case CalibrationPlanStatus.ACTIVE:
        return '生效中';
      case CalibrationPlanStatus.INACTIVE:
        return '已停用';
      case CalibrationPlanStatus.REVOKED:
        return '已撤销';
      default:
        return status;
    }
  }
}
