import {
  InspectionTemplateRepository,
  InspectionRecordRepository,
  DeviceRepository,
  AuditRepository,
  AlarmRepository,
  ReadingRepository,
} from '../../storage/repositories';
import {
  InspectionTemplate,
  InspectionTemplateStatus,
  InspectionRecord,
  InspectionStatus,
  InspectionShift,
  InspectionTemplateDevice,
  CreateInspectionTemplateInput,
  SubmitInspectionInput,
  InspectionFilters,
  InspectionExportFilters,
  InspectionStats,
  PaginatedResult,
  OperationType,
  DeviceStatus,
  AlarmStatus,
} from '../../types';
import {
  NotFoundError,
  ConflictError,
  ValidationError,
  BusinessError,
  UnauthorizedError,
} from '../../utils/errors';
import {
  getTestUsers,
  checkManageInspectionTemplatesPermission,
  checkSubmitInspectionPermission,
  checkViewInspectionPermission,
  checkExportInspectionPermission,
} from '../rules';
import logger from '../../utils/logger';

export class InspectionService {
  constructor(
    private templateRepo: InspectionTemplateRepository,
    private recordRepo: InspectionRecordRepository,
    private deviceRepo: DeviceRepository,
    private auditRepo: AuditRepository,
    private alarmRepo: AlarmRepository,
    private readingRepo: ReadingRepository
  ) {}

  validateTemplateDevice(deviceConfig: InspectionTemplateDevice, templateStoreId: string): void {
    const validUsers = getTestUsers().map(u => u.id);

    const device = this.deviceRepo.findById(deviceConfig.deviceId);
    if (!device) {
      throw new ValidationError(
        `设备"${deviceConfig.deviceId}"不存在`,
        'deviceId',
        { deviceId: deviceConfig.deviceId }
      );
    }

    this.validateDeviceNotCrossStore(deviceConfig.deviceId, device.storeId, templateStoreId);
    this.validateDeviceActive(deviceConfig.deviceId, device.status);

    if (!validUsers.includes(deviceConfig.personInCharge)) {
      throw new ValidationError(
        `设备"${deviceConfig.deviceId}"的负责人"${deviceConfig.personInCharge}"不存在，有效的负责人包括：${validUsers.join(', ')}`,
        'personInCharge',
        { deviceId: deviceConfig.deviceId, value: deviceConfig.personInCharge, validUsers }
      );
    }

    this.validateTimeWindow(deviceConfig.timeWindow.startTime, deviceConfig.timeWindow.endTime);
  }

  validateDeviceNotCrossStore(deviceId: string, deviceStoreId: string, templateStoreId: string): void {
    if (deviceStoreId !== templateStoreId) {
      throw new BusinessError(
        `设备"${deviceId}"的门店(${deviceStoreId})与模板门店(${templateStoreId})不匹配，跨门店设备不允许`,
        'INSPECTION_CROSS_STORE_DEVICE',
        { deviceId, deviceStoreId, templateStoreId }
      );
    }
  }

  validateDeviceActive(deviceId: string, deviceStatus: DeviceStatus): void {
    if (deviceStatus !== DeviceStatus.ACTIVE) {
      throw new ValidationError(
        `设备"${deviceId}"已停用，不能添加到巡检模板或提交巡检`,
        'deviceId',
        { deviceId, deviceStatus }
      );
    }
  }

  validateNoDuplicateDevices(devices: InspectionTemplateDevice[]): void {
    const deviceIds = new Set<string>();
    for (const deviceConfig of devices) {
      if (deviceIds.has(deviceConfig.deviceId)) {
        throw new ValidationError(
          `设备"${deviceConfig.deviceId}"在模板中重复出现`,
          'deviceId',
          { deviceId: deviceConfig.deviceId }
        );
      }
      deviceIds.add(deviceConfig.deviceId);
    }
  }

  validateNoTemplateTimeConflict(storeId: string, date: number, shift: InspectionShift, excludeTemplateId?: string): void {
    const existingTemplates = this.templateRepo.findPublishedForStoreAtDate(
      storeId,
      date,
      shift,
      excludeTemplateId
    );
    if (existingTemplates.length > 0) {
      const conflictDesc = existingTemplates.map(t =>
        `模板ID: ${t.id}, 名称: ${t.name}`
      ).join('; ');
      throw new ConflictError(
        `门店"${storeId}"在${new Date(date).toLocaleDateString('zh-CN')}的${this.getShiftText(shift)}班次已存在发布的巡检模板，时间窗冲突。冲突模板: ${conflictDesc}`,
        {
          storeId,
          date,
          shift,
          conflictingTemplates: existingTemplates.map(t => ({ id: t.id, name: t.name }))
        }
      );
    }
  }

  validateTemplateStatus(templateId: string, currentStatus: InspectionTemplateStatus, allowedStatuses: InspectionTemplateStatus[], operation: string): void {
    if (!allowedStatuses.includes(currentStatus)) {
      throw new ConflictError(
        `巡检模板"${templateId}"当前状态为"${currentStatus}"，无法${operation}`,
        { templateId, currentStatus, allowedStatuses, operation }
      );
    }
  }

  validateReasonProvided(reason: string | undefined, fieldName: string): void {
    if (!reason || reason.trim().length === 0) {
      throw new ValidationError(`${fieldName}不能为空`, 'reason');
    }
  }

  validateDeviceInTemplate(templateId: string, deviceId: string, deviceConfig: InspectionTemplateDevice | null | undefined): void {
    if (!deviceConfig) {
      throw new ValidationError(
        `设备"${deviceId}"不在模板"${templateId}"的巡检清单中`,
        'deviceId',
        { templateId, deviceId }
      );
    }
  }

  validateIsPersonInCharge(deviceId: string, operator: string, requiredPerson: string): void {
    if (requiredPerson !== operator) {
      throw new UnauthorizedError(
        `用户"${operator}"不是设备"${deviceId}"的指定负责人，不能提交该设备的巡检。指定负责人为"${requiredPerson}"`,
        { userId: operator, requiredPerson, deviceId }
      );
    }
  }

  validateNoDuplicateSubmission(templateId: string, deviceId: string, existingRecord: InspectionRecord | null | undefined): void {
    if (existingRecord) {
      throw new ConflictError(
        `设备"${deviceId}"在模板"${templateId}"中已经提交过巡检，不允许重复提交`,
        { templateId, deviceId, existingRecordId: existingRecord.id }
      );
    }
  }

  validatePhotoRequirement(deviceId: string, photos: string[] | undefined, minCount: number, required: boolean): void {
    if (required) {
      if (!photos || photos.length < minCount) {
        throw new ValidationError(
          `设备"${deviceId}"至少需要${minCount}张照片，实际提供${photos?.length || 0}张`,
          'photos',
          { deviceId, required: minCount, actual: photos?.length || 0 }
        );
      }
    }
  }

  validateRemarkRequirement(deviceId: string, remark: string | undefined, minLength: number, required: boolean): void {
    if (required) {
      if (!remark || remark.trim().length < minLength) {
        throw new ValidationError(
          `设备"${deviceId}"的备注至少需要${minLength}个字符`,
          'remark',
          { deviceId, required: minLength, actual: remark?.length || 0 }
        );
      }
    }
  }

  calculateLateness(submittedAt: number, templateDate: number, timeWindowEnd: string): { isLate: boolean; lateMinutes: number | undefined } {
    const timeWindowEndTs = this.parseTimeToTimestamp(templateDate, timeWindowEnd);
    const isLate = submittedAt > timeWindowEndTs;
    const lateMinutes = isLate ? Math.floor((submittedAt - timeWindowEndTs) / 60000) : undefined;
    return { isLate, lateMinutes };
  }

  createTemplate(input: CreateInspectionTemplateInput, operator: string): InspectionTemplate {
    checkManageInspectionTemplatesPermission(operator);

    this.validateTemplateInput(input);
    this.validateNoDuplicateDevices(input.devices);

    for (const deviceConfig of input.devices) {
      this.validateTemplateDevice(deviceConfig, input.storeId);
    }

    this.validateNoTemplateTimeConflict(input.storeId, input.date, input.shift);

    const template = this.templateRepo.create({
      ...input,
      createdBy: operator,
    });

    this.auditRepo.create({
      operationType: OperationType.INSPECTION_TEMPLATE_CREATE,
      entityId: template.id,
      entityType: 'inspection_template',
      operator,
      details: `创建巡检模板：${template.name}，门店${input.storeId}，班次${this.getShiftText(input.shift)}，日期${new Date(input.date).toLocaleDateString('zh-CN')}，包含${input.devices.length}台设备`,
      storeId: input.storeId,
    });

    return template;
  }

  publishTemplate(templateId: string, operator: string, reason?: string): InspectionTemplate {
    checkManageInspectionTemplatesPermission(operator);

    const template = this.getTemplate(templateId);
    this.validateTemplateStatus(templateId, template.status, [InspectionTemplateStatus.DRAFT], '发布');
    this.validateNoTemplateTimeConflict(template.storeId, template.date, template.shift, templateId);

    const now = Date.now();
    const updated = this.templateRepo.updateStatus(
      templateId,
      InspectionTemplateStatus.PUBLISHED,
      {
        publishedAt: now,
        publishedBy: operator,
      }
    );

    if (!updated) {
      throw new ConflictError(`巡检模板"${templateId}"发布失败`, { templateId });
    }

    this.auditRepo.create({
      operationType: OperationType.INSPECTION_TEMPLATE_PUBLISH,
      entityId: templateId,
      entityType: 'inspection_template',
      operator,
      details: `发布巡检模板：${template.name}，门店${template.storeId}，班次${this.getShiftText(template.shift)}，${reason ? '原因：' + reason : ''}`,
      storeId: template.storeId,
    });

    return updated;
  }

  closeTemplate(templateId: string, operator: string, reason: string): InspectionTemplate {
    checkManageInspectionTemplatesPermission(operator);

    const template = this.getTemplate(templateId);
    this.validateTemplateStatus(templateId, template.status, [InspectionTemplateStatus.PUBLISHED], '关闭');
    this.validateReasonProvided(reason, '关闭原因');

    const recordCount = this.templateRepo.getInspectionCountForTemplate(templateId);

    const now = Date.now();
    const updated = this.templateRepo.updateStatus(
      templateId,
      InspectionTemplateStatus.CLOSED,
      {
        closedAt: now,
        closedBy: operator,
        closedReason: reason,
      }
    );

    if (!updated) {
      throw new ConflictError(`巡检模板"${templateId}"关闭失败`, { templateId });
    }

    this.auditRepo.create({
      operationType: OperationType.INSPECTION_TEMPLATE_CLOSE,
      entityId: templateId,
      entityType: 'inspection_template',
      operator,
      details: `关闭巡检模板：${template.name}，原因：${reason}，影响范围：${recordCount.total}条巡检记录（已提交${recordCount.submitted}条，迟到${recordCount.late}条，漏检${recordCount.missed}条）。历史巡检记录保持不变。`,
      storeId: template.storeId,
    });

    return updated;
  }

  revokeTemplate(templateId: string, operator: string, reason: string): InspectionTemplate {
    checkManageInspectionTemplatesPermission(operator);

    const template = this.getTemplate(templateId);
    this.validateTemplateStatus(templateId, template.status, [InspectionTemplateStatus.DRAFT, InspectionTemplateStatus.PUBLISHED], '撤销');
    this.validateReasonProvided(reason, '撤销原因');

    const recordCount = this.templateRepo.getInspectionCountForTemplate(templateId);

    const now = Date.now();
    const updated = this.templateRepo.updateStatus(
      templateId,
      InspectionTemplateStatus.REVOKED,
      {
        revokedAt: now,
        revokedBy: operator,
        revokedReason: reason,
      }
    );

    if (!updated) {
      throw new ConflictError(`巡检模板"${templateId}"撤销失败`, { templateId });
    }

    this.auditRepo.create({
      operationType: OperationType.INSPECTION_TEMPLATE_REVOKE,
      entityId: templateId,
      entityType: 'inspection_template',
      operator,
      details: `撤销巡检模板：${template.name}，原因：${reason}，影响范围：${recordCount.total}条巡检记录（已提交${recordCount.submitted}条，迟到${recordCount.late}条，漏检${recordCount.missed}条）。历史巡检记录保持不变，不可恢复。`,
      storeId: template.storeId,
    });

    return updated;
  }

  getTemplate(templateId: string, operator?: string): InspectionTemplate {
    if (operator) {
      checkViewInspectionPermission(operator);
    }
    const template = this.templateRepo.findById(templateId);
    if (!template) {
      throw new NotFoundError(`巡检模板"${templateId}"不存在`, { templateId });
    }
    return template;
  }

  getTemplateWithDetails(templateId: string, operator: string): any {
    checkViewInspectionPermission(operator);
    const template = this.getTemplate(templateId, operator);
    const counts = this.templateRepo.getInspectionCountForTemplate(templateId);
    return { ...template, ...counts };
  }

  listTemplates(filters: InspectionFilters = {}, operator: string): PaginatedResult<InspectionTemplate> {
    checkViewInspectionPermission(operator);
    return this.templateRepo.findAll(filters);
  }

  listTemplatesWithDetails(filters: InspectionFilters = {}, operator: string): PaginatedResult<any> {
    checkViewInspectionPermission(operator);
    const result = this.templateRepo.findAll(filters);
    const items = result.items.map(template => {
      const counts = this.templateRepo.getInspectionCountForTemplate(template.id);
      return { ...template, ...counts };
    });
    return { ...result, items };
  }

  submitInspection(input: SubmitInspectionInput, operator: string): InspectionRecord {
    checkSubmitInspectionPermission(operator);

    if (input.photos && !Array.isArray(input.photos)) {
      throw new ValidationError('照片必须是数组格式', 'photos');
    }

    const template = this.getTemplate(input.templateId);
    this.validateTemplateStatus(input.templateId, template.status, [InspectionTemplateStatus.PUBLISHED], '提交巡检');

    const deviceConfig = this.templateRepo.getDeviceConfig(input.templateId, input.deviceId);
    this.validateDeviceInTemplate(input.templateId, input.deviceId, deviceConfig);
    if (!deviceConfig) throw new ValidationError(`设备"${input.deviceId}"不在模板中`, 'deviceId');
    this.validateIsPersonInCharge(input.deviceId, operator, deviceConfig.personInCharge);

    const existingRecord = this.recordRepo.findByTemplateAndDevice(input.templateId, input.deviceId);
    this.validateNoDuplicateSubmission(input.templateId, input.deviceId, existingRecord);

    const device = this.deviceRepo.findById(input.deviceId);
    if (!device) {
      throw new ValidationError(`设备"${input.deviceId}"不存在`, 'deviceId');
    }
    this.validateDeviceActive(input.deviceId, device.status);

    this.validatePhotoRequirement(input.deviceId, input.photos, deviceConfig.photoRequirement.minCount, deviceConfig.photoRequirement.required);
    this.validateRemarkRequirement(input.deviceId, input.remark, deviceConfig.remarkRequirement.minLength, deviceConfig.remarkRequirement.required);

    const submittedAt = Date.now();
    const timeWindowStart = this.parseTimeToTimestamp(template.date, deviceConfig.timeWindow.startTime);
    const timeWindowEnd = this.parseTimeToTimestamp(template.date, deviceConfig.timeWindow.endTime);
    const expectedCheckTime = timeWindowStart;

    const { isLate, lateMinutes } = this.calculateLateness(submittedAt, template.date, deviceConfig.timeWindow.endTime);
    let status = isLate ? InspectionStatus.LATE : InspectionStatus.SUBMITTED;

    const latestReading = this.readingRepo.findLatestByDevice(input.deviceId);
    const activeAlarms = this.alarmRepo.findOpenByDevice(input.deviceId);
    const activeAlarm = activeAlarms.length > 0 ? activeAlarms[0] : null;

    const record = this.recordRepo.create({
      templateId: input.templateId,
      deviceId: input.deviceId,
      storeId: template.storeId,
      submittedBy: operator,
      submittedAt,
      status,
      photos: input.photos || [],
      remark: input.remark || '',
      latestReadingId: latestReading?.id,
      latestReadingTemperature: latestReading?.temperature,
      latestReadingTime: latestReading?.readingTime,
      activeAlarmId: activeAlarm?.id,
      activeAlarmType: activeAlarm?.type,
      activeAlarmTemperature: activeAlarm?.temperature,
      activeAlarmThreshold: activeAlarm?.threshold,
      timeWindowStart,
      timeWindowEnd,
      expectedCheckTime,
      isLate,
      lateMinutes,
    });

    this.auditRepo.create({
      operationType: OperationType.INSPECTION_SUBMIT,
      entityId: record.id,
      entityType: 'inspection_record',
      operator,
      details: `提交巡检：模板${template.name}，设备${input.deviceId}，${isLate ? `迟到${lateMinutes}分钟` : '准时提交'}，${activeAlarm ? '当前有活动告警' : '无活动告警'}，${latestReading ? `最新温度${latestReading.temperature}℃` : '无温度读数'}`,
      storeId: template.storeId,
      deviceId: input.deviceId,
    });

    return record;
  }

  getInspection(recordId: string, operator: string): InspectionRecord {
    checkViewInspectionPermission(operator);
    const record = this.recordRepo.findById(recordId);
    if (!record) {
      throw new NotFoundError(`巡检记录"${recordId}"不存在`, { recordId });
    }
    return record;
  }

  listInspections(filters: InspectionFilters = {}, operator: string): PaginatedResult<InspectionRecord> {
    checkViewInspectionPermission(operator);
    return this.recordRepo.findAll(filters);
  }

  listInspectionsWithDetails(filters: InspectionFilters = {}, operator: string): PaginatedResult<any> {
    checkViewInspectionPermission(operator);

    const templatesResult = this.templateRepo.findAll({ pageSize: 10000 });
    const templates = new Map<string, InspectionTemplate>();
    templatesResult.items.forEach(t => templates.set(t.id, t));

    const devicesResult = this.deviceRepo.findAll({ pageSize: 10000 });
    const devices = new Map<string, { name: string; storeId: string; storeName: string }>();
    devicesResult.items.forEach(d => devices.set(d.id, { name: d.name, storeId: d.storeId, storeName: d.storeName }));

    return this.recordRepo.findAllWithDetails(filters, templates, devices);
  }

  getStats(filters: InspectionFilters = {}, operator: string): InspectionStats {
    checkViewInspectionPermission(operator);

    const recordCounts = this.recordRepo.countByFilters(filters);

    return {
      totalTemplates: this.templateRepo.countByStatus(InspectionTemplateStatus.DRAFT) +
        this.templateRepo.countByStatus(InspectionTemplateStatus.PUBLISHED) +
        this.templateRepo.countByStatus(InspectionTemplateStatus.CLOSED) +
        this.templateRepo.countByStatus(InspectionTemplateStatus.REVOKED),
      publishedTemplates: this.templateRepo.countByStatus(InspectionTemplateStatus.PUBLISHED),
      closedTemplates: this.templateRepo.countByStatus(InspectionTemplateStatus.CLOSED),
      revokedTemplates: this.templateRepo.countByStatus(InspectionTemplateStatus.REVOKED),
      totalInspections: recordCounts.total,
      submittedInspections: recordCounts.submitted,
      lateInspections: recordCounts.late,
      missedInspections: recordCounts.missed,
      pendingInspections: recordCounts.pending,
    };
  }

  export(
    filters: InspectionExportFilters = {},
    operator: string
  ): { content: string; contentType: string; filename: string } {
    checkExportInspectionPermission(operator);

    const format = filters.format || 'csv';
    const type = filters.type || 'records';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (type === 'templates') {
      if (format === 'json') {
        return {
          content: this.exportTemplatesToJson(filters, operator),
          contentType: 'application/json; charset=utf-8',
          filename: `inspection_templates_${timestamp}.json`,
        };
      }
      return {
        content: this.exportTemplatesToCsv(filters, operator),
        contentType: 'text/csv; charset=utf-8',
        filename: `inspection_templates_${timestamp}.csv`,
      };
    }

    if (format === 'json') {
      return {
        content: this.exportRecordsToJson(filters, operator),
        contentType: 'application/json; charset=utf-8',
        filename: `inspection_records_${timestamp}.json`,
      };
    }

    return {
      content: this.exportRecordsToCsv(filters, operator),
      contentType: 'text/csv; charset=utf-8',
      filename: `inspection_records_${timestamp}.csv`,
    };
  }

  private exportTemplatesToCsv(filters: InspectionExportFilters, operator: string): string {
    const result = this.templateRepo.findAll({ ...filters, pageSize: 10000 });

    const headers = [
      '模板ID', '模板名称', '门店ID', '门店名称', '班次', '日期',
      '状态', '设备数量', '创建人', '创建时间', '发布时间', '发布人',
      '关闭时间', '关闭人', '关闭原因', '撤销时间', '撤销人', '撤销原因'
    ];

    const rows = result.items.map(template => [
      template.id,
      `"${template.name.replace(/"/g, '""')}"`,
      template.storeId,
      `"${template.storeName.replace(/"/g, '""')}"`,
      this.getShiftText(template.shift),
      new Date(template.date).toLocaleDateString('zh-CN'),
      this.getTemplateStatusText(template.status),
      template.devices.length,
      template.createdBy,
      new Date(template.createdAt).toLocaleString('zh-CN'),
      template.publishedAt ? new Date(template.publishedAt).toLocaleString('zh-CN') : '',
      template.publishedBy || '',
      template.closedAt ? new Date(template.closedAt).toLocaleString('zh-CN') : '',
      template.closedBy || '',
      template.closedReason ? `"${template.closedReason.replace(/"/g, '""')}"` : '',
      template.revokedAt ? new Date(template.revokedAt).toLocaleString('zh-CN') : '',
      template.revokedBy || '',
      template.revokedReason ? `"${template.revokedReason.replace(/"/g, '""')}"` : '',
    ]);

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  private exportTemplatesToJson(filters: InspectionExportFilters, operator: string): string {
    const result = this.listTemplatesWithDetails(filters, operator);
    return JSON.stringify({
      filters,
      ...result,
    }, null, 2);
  }

  private exportRecordsToCsv(filters: InspectionExportFilters, operator: string): string {
    const result = this.listInspectionsWithDetails(filters, operator);

    const headers = [
      '巡检记录ID', '模板ID', '模板名称', '班次', '模板日期',
      '设备ID', '设备名称', '门店ID', '提交人', '提交时间',
      '状态', '是否迟到', '迟到分钟数', '照片数量', '备注',
      '最新温度读数ID', '最新温度', '最新读数时间',
      '活动告警ID', '告警类型', '告警温度', '告警阈值',
      '时间窗开始', '时间窗结束'
    ];

    const rows = result.items.map((record: any) => [
      record.id,
      record.templateId,
      `"${record.templateName?.replace(/"/g, '""') || ''}"`,
      record.shift ? this.getShiftText(record.shift) : '',
      record.templateDate ? new Date(record.templateDate).toLocaleDateString('zh-CN') : '',
      record.deviceId,
      `"${record.deviceName?.replace(/"/g, '""') || ''}"`,
      record.storeId,
      record.submittedBy,
      new Date(record.submittedAt).toLocaleString('zh-CN'),
      this.getInspectionStatusText(record.status),
      record.isLate ? '是' : '否',
      record.lateMinutes || '',
      record.photos?.length || 0,
      `"${(record.remark || '').replace(/"/g, '""')}"`,
      record.latestReadingId || '',
      record.latestReadingTemperature ?? '',
      record.latestReadingTime ? new Date(record.latestReadingTime).toLocaleString('zh-CN') : '',
      record.activeAlarmId || '',
      record.activeAlarmType || '',
      record.activeAlarmTemperature ?? '',
      record.activeAlarmThreshold ?? '',
      record.timeWindowStart ? new Date(record.timeWindowStart).toLocaleString('zh-CN') : '',
      record.timeWindowEnd ? new Date(record.timeWindowEnd).toLocaleString('zh-CN') : '',
    ]);

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  private exportRecordsToJson(filters: InspectionExportFilters, operator: string): string {
    const result = this.listInspectionsWithDetails(filters, operator);
    return JSON.stringify({
      filters,
      ...result,
    }, null, 2);
  }

  private validateTemplateInput(input: CreateInspectionTemplateInput): void {
    if (!input.name || input.name.trim().length === 0) {
      throw new ValidationError('模板名称不能为空', 'name');
    }
    if (input.name.length > 100) {
      throw new ValidationError('模板名称不能超过100字符', 'name', { length: input.name.length, max: 100 });
    }
    if (!input.storeId || input.storeId.trim().length === 0) {
      throw new ValidationError('门店ID不能为空', 'storeId');
    }
    if (!input.storeName || input.storeName.trim().length === 0) {
      throw new ValidationError('门店名称不能为空', 'storeName');
    }
    if (!input.date || isNaN(input.date)) {
      throw new ValidationError('日期必须是有效的时间戳', 'date');
    }
    if (input.date < 946656000000 || input.date > 4102444800000) {
      throw new ValidationError('日期必须在有效范围内（2000-01-01 ~ 2100-01-01）', 'date');
    }
    if (!input.devices || input.devices.length === 0) {
      throw new ValidationError('至少需要配置一台设备', 'devices');
    }
  }

  private validateTimeWindow(startTime: string, endTime: string): void {
    const timePattern = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timePattern.test(startTime)) {
      throw new ValidationError(
        `开始时间"${startTime}"格式无效，应为HH:mm格式`,
        'timeWindow.startTime',
        { value: startTime }
      );
    }
    if (!timePattern.test(endTime)) {
      throw new ValidationError(
        `结束时间"${endTime}"格式无效，应为HH:mm格式`,
        'timeWindow.endTime',
        { value: endTime }
      );
    }

    const startMinutes = this.timeToMinutes(startTime);
    const endMinutes = this.timeToMinutes(endTime);
    if (startMinutes >= endMinutes) {
      throw new ValidationError(
        `开始时间"${startTime}"必须早于结束时间"${endTime}"`,
        'timeWindow',
        { startTime, endTime }
      );
    }
  }

  private timeToMinutes(time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  }

  private parseTimeToTimestamp(date: number, time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    const d = new Date(date);
    d.setHours(hours, minutes, 0, 0);
    return d.getTime();
  }

  private getShiftText(shift: InspectionShift): string {
    const shiftMap: Record<InspectionShift, string> = {
      [InspectionShift.MORNING]: '早班',
      [InspectionShift.AFTERNOON]: '午班',
      [InspectionShift.EVENING]: '晚班',
      [InspectionShift.NIGHT]: '夜班',
    };
    return shiftMap[shift] || shift;
  }

  private getTemplateStatusText(status: InspectionTemplateStatus): string {
    const statusMap: Record<InspectionTemplateStatus, string> = {
      [InspectionTemplateStatus.DRAFT]: '草稿',
      [InspectionTemplateStatus.PUBLISHED]: '已发布',
      [InspectionTemplateStatus.CLOSED]: '已关闭',
      [InspectionTemplateStatus.REVOKED]: '已撤销',
    };
    return statusMap[status] || status;
  }

  private getInspectionStatusText(status: InspectionStatus): string {
    const statusMap: Record<InspectionStatus, string> = {
      [InspectionStatus.PENDING]: '待检',
      [InspectionStatus.SUBMITTED]: '已提交',
      [InspectionStatus.LATE]: '迟到',
      [InspectionStatus.MISSED]: '漏检',
    };
    return statusMap[status] || status;
  }
}
