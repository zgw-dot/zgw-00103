import { prepare, runInTransaction, saveDatabase } from '../database';
import { IdempotencyKeyRecord } from '../../types';
import crypto from 'crypto';

export class IdempotencyKeyRepository {

  create(record: Omit<IdempotencyKeyRecord, 'id' | 'createdAt' | 'lastSubmitAt' | 'submitCount'> & { submitCount?: number }): IdempotencyKeyRecord {
    const id = `idem-${crypto.randomUUID()}`;
    const now = Date.now();
    const submitCount = record.submitCount || 1;
    const stmt = prepare(`
      INSERT INTO idempotency_keys (
        id, idempotency_key, operator, file_content_hash, original_batch_id,
        submit_count, created_at, last_submit_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      record.idempotencyKey,
      record.operator,
      record.fileContentHash,
      record.originalBatchId,
      submitCount,
      now,
      now
    );
    saveDatabase();
    return {
      ...record,
      id,
      submitCount,
      createdAt: now,
      lastSubmitAt: now,
    };
  }

  findByKeyAndOperator(idempotencyKey: string, operator: string): IdempotencyKeyRecord | null {
    const row = prepare(
      'SELECT * FROM idempotency_keys WHERE idempotency_key = ? AND operator = ?'
    ).get(idempotencyKey, operator) as any;
    return row ? this.mapToRecord(row) : null;
  }

  updateSubmitCount(id: string): IdempotencyKeyRecord | null {
    const now = Date.now();
    const stmt = prepare(
      'UPDATE idempotency_keys SET submit_count = submit_count + 1, last_submit_at = ? WHERE id = ?'
    );
    const result = stmt.run(now, id);
    if (result.changes === 0) return null;
    saveDatabase();
    return this.findById(id);
  }

  findById(id: string): IdempotencyKeyRecord | null {
    const row = prepare('SELECT * FROM idempotency_keys WHERE id = ?').get(id) as any;
    return row ? this.mapToRecord(row) : null;
  }

  private mapToRecord(row: any): IdempotencyKeyRecord {
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      operator: row.operator,
      fileContentHash: row.file_content_hash,
      originalBatchId: row.original_batch_id,
      submitCount: row.submit_count,
      createdAt: row.created_at,
      lastSubmitAt: row.last_submit_at,
    };
  }
}
