import { DeviceRepository, AuditRepository } from '../../storage/repositories';
import { Device, DeviceStatus, OperationType, QueryFilters, PaginatedResult } from '../../types';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { checkDeviceManagePermission } from '../rules';

export class DeviceService {
  constructor(
    private deviceRepo: DeviceRepository,
    private auditRepo: AuditRepository
  ) {}

  createDevice(
    data: { id: string; name: string; storeId: string; storeName: string; status?: DeviceStatus },
    operator: string
  ): Device {
    checkDeviceManagePermission(operator);

    const existing = this.deviceRepo.findById(data.id);
    if (existing) {
      throw new ConflictError(`设备ID "${data.id}"已存在`, { deviceId: data.id });
    }

    const device = this.deviceRepo.create({
      id: data.id,
      name: data.name,
      storeId: data.storeId,
      storeName: data.storeName,
      status: data.status || DeviceStatus.ACTIVE,
    });

    this.auditRepo.create({
      operationType: OperationType.DEVICE_CREATE,
      entityId: device.id,
      entityType: 'device',
      operator,
      details: `创建设备：${device.name} (${device.id})，门店：${device.storeName}`,
      storeId: device.storeId,
      deviceId: device.id,
    });

    return device;
  }

  getDevice(id: string): Device {
    const device = this.deviceRepo.findById(id);
    if (!device) {
      throw new NotFoundError(`设备"${id}"不存在`, { deviceId: id });
    }
    return device;
  }

  listDevices(filters: QueryFilters = {}): PaginatedResult<Device> {
    return this.deviceRepo.findAll(filters);
  }

  updateDevice(
    id: string,
    data: Partial<Pick<Device, 'name' | 'storeId' | 'storeName' | 'status'>>,
    operator: string
  ): Device {
    checkDeviceManagePermission(operator);

    const existing = this.deviceRepo.findById(id);
    if (!existing) {
      throw new NotFoundError(`设备"${id}"不存在`, { deviceId: id });
    }

    const updated = this.deviceRepo.update(id, data);
    if (!updated) {
      throw new NotFoundError(`设备"${id}"更新失败`, { deviceId: id });
    }

    const changes: string[] = [];
    if (data.name !== undefined && data.name !== existing.name) {
      changes.push(`名称: ${existing.name} → ${data.name}`);
    }
    if (data.storeId !== undefined && data.storeId !== existing.storeId) {
      changes.push(`门店ID: ${existing.storeId} → ${data.storeId}`);
    }
    if (data.storeName !== undefined && data.storeName !== existing.storeName) {
      changes.push(`门店名称: ${existing.storeName} → ${data.storeName}`);
    }
    if (data.status !== undefined && data.status !== existing.status) {
      changes.push(`状态: ${existing.status} → ${data.status}`);
    }

    this.auditRepo.create({
      operationType: OperationType.DEVICE_UPDATE,
      entityId: id,
      entityType: 'device',
      operator,
      details: `更新设备：${updated.name}，变更内容：${changes.join('; ') || '无'}`,
      storeId: updated.storeId,
      deviceId: id,
    });

    return updated;
  }

  updateStatus(id: string, status: DeviceStatus, operator: string): Device {
    return this.updateDevice(id, { status }, operator);
  }

  exists(id: string): boolean {
    return this.deviceRepo.exists(id);
  }

  isActive(id: string): boolean {
    return this.deviceRepo.isActive(id);
  }
}
