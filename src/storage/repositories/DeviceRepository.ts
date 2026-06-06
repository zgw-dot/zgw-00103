import { prepare, runInTransaction, saveDatabase } from '../database';
import { Device, DeviceStatus, QueryFilters, PaginatedResult } from '../../types';

export class DeviceRepository {

  create(device: Omit<Device, 'createdAt' | 'updatedAt'>): Device {
    const now = Date.now();
    const stmt = prepare(`
      INSERT INTO devices (id, name, store_id, store_name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(device.id, device.name, device.storeId, device.storeName, device.status, now, now);
    saveDatabase();
    return { ...device, createdAt: now, updatedAt: now };
  }

  findById(id: string): Device | null {
    const row = prepare('SELECT * FROM devices WHERE id = ?').get(id) as any;
    return row ? this.mapToDevice(row) : null;
  }

  findAll(filters: QueryFilters = {}): PaginatedResult<Device> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.storeId) {
      conditions.push('store_id = ?');
      params.push(filters.storeId);
    }
    if (filters.deviceId) {
      conditions.push('id = ?');
      params.push(filters.deviceId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countStmt = prepare(`SELECT COUNT(*) as count FROM devices ${whereClause}`);
    const total = (countStmt.get(...params) as { count: number }).count;

    const page = filters.page || 1;
    const pageSize = filters.pageSize || 50;
    const offset = (page - 1) * pageSize;

    const rows = prepare(`
      SELECT * FROM devices ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as any[];

    return {
      items: rows.map(this.mapToDevice),
      total,
      page,
      pageSize,
    };
  }

  updateStatus(id: string, status: DeviceStatus): Device | null {
    const now = Date.now();
    const stmt = prepare(`
      UPDATE devices SET status = ?, updated_at = ? WHERE id = ?
    `);
    const result = stmt.run(status, now, id);
    if (result.changes === 0) return null;
    saveDatabase();
    return this.findById(id);
  }

  update(id: string, data: Partial<Pick<Device, 'name' | 'storeId' | 'storeName' | 'status'>>): Device | null {
    const now = Date.now();
    const fields: string[] = [];
    const params: any[] = [];

    if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name); }
    if (data.storeId !== undefined) { fields.push('store_id = ?'); params.push(data.storeId); }
    if (data.storeName !== undefined) { fields.push('store_name = ?'); params.push(data.storeName); }
    if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status); }

    fields.push('updated_at = ?');
    params.push(now, id);

    const stmt = prepare(`UPDATE devices SET ${fields.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);
    if (result.changes === 0) return null;
    saveDatabase();
    return this.findById(id);
  }

  exists(id: string): boolean {
    const row = prepare('SELECT 1 FROM devices WHERE id = ?').get(id);
    return !!row;
  }

  isActive(id: string): boolean {
    const row = prepare("SELECT status FROM devices WHERE id = ?").get(id) as { status: string } | undefined;
    return row?.status === DeviceStatus.ACTIVE;
  }

  private mapToDevice(row: any): Device {
    return {
      id: row.id,
      name: row.name,
      storeId: row.store_id,
      storeName: row.store_name,
      status: row.status as DeviceStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
