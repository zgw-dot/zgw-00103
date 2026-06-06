import { prepare, runInTransaction, saveDatabase } from '../database';
import { Threshold } from '../../types';
import crypto from 'crypto';

export class ThresholdRepository {

  create(threshold: Omit<Threshold, 'id' | 'createdAt' | 'updatedAt'>): Threshold {
    const id = `th-${crypto.randomUUID()}`;
    const now = Date.now();
    const stmt = prepare(`
      INSERT INTO thresholds (id, device_id, store_id, is_default, min_temp, max_temp, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      threshold.deviceId,
      threshold.storeId,
      threshold.isDefault ? 1 : 0,
      threshold.minTemp,
      threshold.maxTemp,
      now,
      now
    );
    saveDatabase();
    return { ...threshold, id, createdAt: now, updatedAt: now };
  }

  findDefault(): Threshold | null {
    const row = prepare('SELECT * FROM thresholds WHERE is_default = 1').get() as any;
    return row ? this.mapToThreshold(row) : null;
  }

  findByStoreId(storeId: string): Threshold | null {
    const row = prepare('SELECT * FROM thresholds WHERE store_id = ? AND device_id IS NULL').get(storeId) as any;
    return row ? this.mapToThreshold(row) : null;
  }

  findByDeviceId(deviceId: string): Threshold | null {
    const row = prepare('SELECT * FROM thresholds WHERE device_id = ?').get(deviceId) as any;
    return row ? this.mapToThreshold(row) : null;
  }

  findByDeviceIdWithFallback(deviceId: string, storeId: string): Threshold {
    let threshold = this.findByDeviceId(deviceId);
    if (threshold) return threshold;

    threshold = this.findByStoreId(storeId);
    if (threshold) return threshold;

    return this.findDefault()!;
  }

  updateDefault(minTemp: number, maxTemp: number): Threshold | null {
    const existing = this.findDefault();
    if (!existing) return null;

    const now = Date.now();
    prepare(`
      UPDATE thresholds SET min_temp = ?, max_temp = ?, updated_at = ?
      WHERE is_default = 1
    `).run(minTemp, maxTemp, now);

    saveDatabase();
    return this.findDefault();
  }

  upsertStoreThreshold(storeId: string, minTemp: number, maxTemp: number): Threshold {
    const existing = this.findByStoreId(storeId);
    const now = Date.now();

    if (existing) {
      prepare(`
        UPDATE thresholds SET min_temp = ?, max_temp = ?, updated_at = ?
        WHERE store_id = ? AND device_id IS NULL
      `).run(minTemp, maxTemp, now, storeId);
      saveDatabase();
      return this.findByStoreId(storeId)!;
    }

    return this.create({
      deviceId: null,
      storeId,
      isDefault: false,
      minTemp,
      maxTemp,
    });
  }

  upsertDeviceThreshold(deviceId: string, minTemp: number, maxTemp: number): Threshold {
    const existing = this.findByDeviceId(deviceId);
    const now = Date.now();

    if (existing) {
      prepare(`
        UPDATE thresholds SET min_temp = ?, max_temp = ?, updated_at = ?
        WHERE device_id = ?
      `).run(minTemp, maxTemp, now, deviceId);
      saveDatabase();
      return this.findByDeviceId(deviceId)!;
    }

    return this.create({
      deviceId,
      storeId: null,
      isDefault: false,
      minTemp,
      maxTemp,
    });
  }

  deleteDeviceThreshold(deviceId: string): boolean {
    const result = prepare('DELETE FROM thresholds WHERE device_id = ?').run(deviceId);
    if (result.changes > 0) saveDatabase();
    return result.changes > 0;
  }

  deleteStoreThreshold(storeId: string): boolean {
    const result = prepare('DELETE FROM thresholds WHERE store_id = ? AND device_id IS NULL').run(storeId);
    if (result.changes > 0) saveDatabase();
    return result.changes > 0;
  }

  private mapToThreshold(row: any): Threshold {
    return {
      id: row.id,
      deviceId: row.device_id,
      storeId: row.store_id,
      isDefault: row.is_default === 1,
      minTemp: row.min_temp,
      maxTemp: row.max_temp,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
