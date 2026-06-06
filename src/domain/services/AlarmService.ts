import { AlarmRepository, AuditRepository, DeviceRepository, ThresholdRepository } from '../../storage/repositories';
import { Alarm, AlarmStatus, OperationType, QueryFilters, PaginatedResult, TemperatureReading, Threshold } from '../../types';
import { NotFoundError, ConflictError, UnauthorizedError } from '../../utils/errors';
import {
  canAcknowledge,
  canClose,
  canRecover,
  getAlarmStatusAfterAcknowledge,
  checkThresholdViolation,
  findMatchingAlarmForRecovery,
  shouldCreateNewAlarm,
  checkAcknowledgePermission,
  checkClosePermission,
} from '../rules';

export class AlarmService {
  constructor(
    private alarmRepo: AlarmRepository,
    private auditRepo: AuditRepository,
    private deviceRepo: DeviceRepository,
    private thresholdRepo: ThresholdRepository
  ) {}

  getAlarm(id: string): Alarm {
    const alarm = this.alarmRepo.findById(id);
    if (!alarm) {
      throw new NotFoundError(`告警"${id}"不存在`, { alarmId: id });
    }
    return alarm;
  }

  listAlarms(filters: QueryFilters = {}): PaginatedResult<Alarm> {
    return this.alarmRepo.findAll(filters);
  }

  acknowledgeAlarm(id: string, operator: string, note?: string): Alarm {
    checkAcknowledgePermission(operator);

    const alarm = this.getAlarm(id);
    if (!canAcknowledge(alarm)) {
      throw new ConflictError(
        `告警状态为"${alarm.status}"，无法确认。仅open或recovered状态的告警可以确认`,
        { alarmId: id, currentStatus: alarm.status }
      );
    }

    const now = Date.now();
    const newStatus = getAlarmStatusAfterAcknowledge(alarm.status);
    const updated = this.alarmRepo.updateStatus(id, newStatus, {
      acknowledgedAt: now,
      acknowledgedBy: operator,
    });

    if (!updated) {
      throw new ConflictError(`告警"${id}"确认失败`, { alarmId: id });
    }

    const device = this.deviceRepo.findById(alarm.deviceId);
    this.auditRepo.create({
      operationType: OperationType.ALARM_ACKNOWLEDGE,
      entityId: id,
      entityType: 'alarm',
      operator,
      details: `确认告警：${alarm.type} ${alarm.temperature}℃ (阈值: ${alarm.threshold}℃)${note ? `，备注：${note}` : ''}`,
      alarmId: id,
      deviceId: alarm.deviceId,
      storeId: device?.storeId,
    });

    return updated;
  }

  closeAlarm(id: string, operator: string, note: string): Alarm {
    checkClosePermission(operator);

    const alarm = this.getAlarm(id);
    if (!canClose(alarm)) {
      throw new ConflictError(
        `告警状态为"${alarm.status}"，无法关闭。仅recovered或acknowledged状态的告警可以关闭`,
        { alarmId: id, currentStatus: alarm.status }
      );
    }

    if (alarm.status !== AlarmStatus.RECOVERED && alarm.status !== AlarmStatus.ACKNOWLEDGED) {
      throw new ConflictError(
        `告警尚未恢复，无法关闭。当前状态：${alarm.status}`,
        { alarmId: id, currentStatus: alarm.status }
      );
    }

    const now = Date.now();
    const updated = this.alarmRepo.updateStatus(id, AlarmStatus.CLOSED, {
      closedAt: now,
      closedBy: operator,
      closeNote: note,
    });

    if (!updated) {
      throw new ConflictError(`告警"${id}"关闭失败`, { alarmId: id });
    }

    const device = this.deviceRepo.findById(alarm.deviceId);
    this.auditRepo.create({
      operationType: OperationType.ALARM_CLOSE,
      entityId: id,
      entityType: 'alarm',
      operator,
      details: `关闭告警：${alarm.type} ${alarm.temperature}℃ → ${alarm.recoveredTemperature || 'N/A'}℃，关闭原因：${note}`,
      alarmId: id,
      deviceId: alarm.deviceId,
      storeId: device?.storeId,
    });

    return updated;
  }

  processReadingForAlarms(
    reading: TemperatureReading,
    deviceId: string,
    storeId: string
  ): { createdAlarm?: Alarm; recoveredAlarm?: Alarm } {
    const threshold = this.thresholdRepo.findByDeviceIdWithFallback(deviceId, storeId);
    const openAlarms = this.alarmRepo.findOpenByDevice(deviceId);
    const result: { createdAlarm?: Alarm; recoveredAlarm?: Alarm } = {};

    const violation = checkThresholdViolation(reading.temperature, threshold);

    if (violation.violated) {
      if (shouldCreateNewAlarm(reading, openAlarms)) {
        result.createdAlarm = this.createAlarm({
          deviceId,
          type: violation.type!,
          threshold: violation.thresholdValue!,
          readingId: reading.id!,
          readingTime: reading.readingTime,
          temperature: reading.temperature,
          originalTemperature: reading.originalTemperature,
          calibrationPlanId: reading.calibrationPlanId,
          status: AlarmStatus.OPEN,
        });
      }
    } else {
      const matchingAlarm = findMatchingAlarmForRecovery(reading.temperature, openAlarms, threshold);
      if (matchingAlarm && canRecover(matchingAlarm)) {
        result.recoveredAlarm = this.recoverAlarm(matchingAlarm.id, reading);
      }
    }

    return result;
  }

  private createAlarm(data: Omit<Alarm, 'id' | 'createdAt' | 'updatedAt'>): Alarm {
    const alarm = this.alarmRepo.create(data);

    const device = this.deviceRepo.findById(data.deviceId);
    const calibrationInfo = data.calibrationPlanId
      ? `，原始温度${data.originalTemperature}℃，校准计划${data.calibrationPlanId}`
      : '';
    this.auditRepo.create({
      operationType: OperationType.READING_IMPORT,
      entityId: alarm.id,
      entityType: 'alarm',
      operator: 'system',
      details: `生成告警：${data.type} 温度${data.temperature}℃ 超出阈值${data.threshold}℃${calibrationInfo}`,
      alarmId: alarm.id,
      deviceId: data.deviceId,
      storeId: device?.storeId,
    });

    return alarm;
  }

  private recoverAlarm(alarmId: string, reading: TemperatureReading): Alarm {
    const alarm = this.alarmRepo.findById(alarmId);
    if (!alarm) {
      throw new NotFoundError(`告警"${alarmId}"不存在`, { alarmId });
    }

    const now = Date.now();
    const updated = this.alarmRepo.updateStatus(alarmId, AlarmStatus.RECOVERED, {
      recoveredAt: now,
      recoveredReadingId: reading.id!,
      recoveredTemperature: reading.temperature,
      recoveredOriginalTemperature: reading.originalTemperature,
      recoveredCalibrationPlanId: reading.calibrationPlanId,
    });

    if (!updated) {
      throw new ConflictError(`告警"${alarmId}"恢复失败`, { alarmId });
    }

    const device = this.deviceRepo.findById(alarm.deviceId);
    const calibrationInfo = reading.calibrationPlanId
      ? `，恢复时原始温度${reading.originalTemperature}℃，校准计划${reading.calibrationPlanId}`
      : '';
    this.auditRepo.create({
      operationType: OperationType.ALARM_RECOVER,
      entityId: alarmId,
      entityType: 'alarm',
      operator: 'system',
      details: `告警自动恢复：温度从${alarm.temperature}℃恢复至${reading.temperature}℃${calibrationInfo}`,
      alarmId,
      deviceId: alarm.deviceId,
      storeId: device?.storeId,
    });

    return updated;
  }

  countByStatus(status: AlarmStatus): number {
    return this.alarmRepo.countByStatus(status);
  }

  getOpenAlarmsByDevice(deviceId: string): Alarm[] {
    return this.alarmRepo.findOpenByDevice(deviceId);
  }
}
