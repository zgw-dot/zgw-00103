import { ThresholdRepository, AuditRepository, DeviceRepository } from '../../storage/repositories';
import { Threshold, OperationType, QueryFilters, PaginatedResult } from '../../types';
import { NotFoundError, ConflictError } from '../../utils/errors';
import { checkThresholdManagePermission } from '../rules';

export class ThresholdService {
  constructor(
    private thresholdRepo: ThresholdRepository,
    private auditRepo: AuditRepository,
    private deviceRepo: DeviceRepository
  ) {}

  getDefaultThreshold(): Threshold {
    const threshold = this.thresholdRepo.findDefault();
    if (!threshold) {
      throw new NotFoundError('默认阈值不存在');
    }
    return threshold;
  }

  updateDefaultThreshold(minTemp: number, maxTemp: number, operator: string): Threshold {
    checkThresholdManagePermission(operator);

    const existing = this.thresholdRepo.findDefault();
    if (!existing) {
      throw new NotFoundError('默认阈值不存在');
    }

    const updated = this.thresholdRepo.updateDefault(minTemp, maxTemp);
    if (!updated) {
      throw new ConflictError('更新默认阈值失败');
    }

    this.auditRepo.create({
      operationType: OperationType.THRESHOLD_SET,
      entityId: updated.id!,
      entityType: 'threshold',
      operator,
      details: `更新默认阈值：${existing.minTemp}℃~${existing.maxTemp}℃ → ${minTemp}℃~${maxTemp}℃`,
    });

    return updated;
  }

  getStoreThreshold(storeId: string): Threshold {
    const threshold = this.thresholdRepo.findByStoreId(storeId);
    if (!threshold) {
      throw new NotFoundError(`门店"${storeId}"的阈值不存在`, { storeId });
    }
    return threshold;
  }

  setStoreThreshold(storeId: string, minTemp: number, maxTemp: number, operator: string): Threshold {
    checkThresholdManagePermission(operator);

    const existing = this.thresholdRepo.findByStoreId(storeId);
    const threshold = this.thresholdRepo.upsertStoreThreshold(storeId, minTemp, maxTemp);

    const changeDesc = existing
      ? `${existing.minTemp}℃~${existing.maxTemp}℃ → ${minTemp}℃~${maxTemp}℃`
      : `设置为 ${minTemp}℃~${maxTemp}℃`;

    this.auditRepo.create({
      operationType: OperationType.THRESHOLD_SET,
      entityId: threshold.id!,
      entityType: 'threshold',
      operator,
      details: `门店"${storeId}"阈值${changeDesc}`,
      storeId,
    });

    return threshold;
  }

  deleteStoreThreshold(storeId: string, operator: string): boolean {
    checkThresholdManagePermission(operator);

    const existing = this.thresholdRepo.findByStoreId(storeId);
    if (!existing) {
      throw new NotFoundError(`门店"${storeId}"的阈值不存在`, { storeId });
    }

    const result = this.thresholdRepo.deleteStoreThreshold(storeId);

    if (result) {
      this.auditRepo.create({
        operationType: OperationType.THRESHOLD_SET,
        entityId: existing.id!,
        entityType: 'threshold',
        operator,
        details: `删除门店"${storeId}"阈值，将使用默认阈值`,
        storeId,
      });
    }

    return result;
  }

  getDeviceThreshold(deviceId: string): Threshold {
    const threshold = this.thresholdRepo.findByDeviceId(deviceId);
    if (!threshold) {
      throw new NotFoundError(`设备"${deviceId}"的阈值不存在`, { deviceId });
    }
    return threshold;
  }

  getEffectiveThreshold(deviceId: string): Threshold {
    const device = this.deviceRepo.findById(deviceId);
    if (!device) {
      throw new NotFoundError(`设备"${deviceId}"不存在`, { deviceId });
    }
    return this.thresholdRepo.findByDeviceIdWithFallback(deviceId, device.storeId);
  }

  setDeviceThreshold(deviceId: string, minTemp: number, maxTemp: number, operator: string): Threshold {
    checkThresholdManagePermission(operator);

    const device = this.deviceRepo.findById(deviceId);
    if (!device) {
      throw new NotFoundError(`设备"${deviceId}"不存在`, { deviceId });
    }

    const existing = this.thresholdRepo.findByDeviceId(deviceId);
    const threshold = this.thresholdRepo.upsertDeviceThreshold(deviceId, minTemp, maxTemp);

    const changeDesc = existing
      ? `${existing.minTemp}℃~${existing.maxTemp}℃ → ${minTemp}℃~${maxTemp}℃`
      : `设置为 ${minTemp}℃~${maxTemp}℃`;

    this.auditRepo.create({
      operationType: OperationType.THRESHOLD_SET,
      entityId: threshold.id!,
      entityType: 'threshold',
      operator,
      details: `设备"${device.name}"(${deviceId})阈值${changeDesc}`,
      deviceId,
      storeId: device.storeId,
    });

    return threshold;
  }

  deleteDeviceThreshold(deviceId: string, operator: string): boolean {
    checkThresholdManagePermission(operator);

    const existing = this.thresholdRepo.findByDeviceId(deviceId);
    if (!existing) {
      throw new NotFoundError(`设备"${deviceId}"的阈值不存在`, { deviceId });
    }

    const device = this.deviceRepo.findById(deviceId);
    const result = this.thresholdRepo.deleteDeviceThreshold(deviceId);

    if (result) {
      this.auditRepo.create({
        operationType: OperationType.THRESHOLD_SET,
        entityId: existing.id!,
        entityType: 'threshold',
        operator,
        details: `删除设备"${device?.name || deviceId}"阈值，将使用门店或默认阈值`,
        deviceId,
        storeId: device?.storeId,
      });
    }

    return result;
  }

  listAllThresholds(): Threshold[] {
    const result = this.thresholdRepo.findDefault();
    const thresholds: Threshold[] = [];
    if (result) thresholds.push(result);
    return thresholds;
  }
}
