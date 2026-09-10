import { isCommerceDocumentSegment } from '../../../../shared/commerceDocumentPath.js';
import { isStripeChargebackSessionId, isStripeDisputeId } from '../../../../shared/stripeChargebacks.js';

export type StripeChargebackRecord = {
  livemode: boolean;
  sessionId: string;
  disputeId: string;
  dropId: string;
  chargeId: string;
  paymentIntentId: string;
  disputeCreatedAt: number;
  recordedAtMs: number;
};

export class StripeChargebackStoreError extends Error {
  readonly code = 'chargeback-identity-conflict';

  constructor() {
    super('Stripe chargeback identity does not match its stored association.');
    this.name = 'StripeChargebackStoreError';
  }
}

function validateRecord(value: StripeChargebackRecord): void {
  if (typeof value.livemode !== 'boolean' || !isStripeChargebackSessionId(value.sessionId) ||
    value.sessionId.startsWith('cs_live_') !== value.livemode || !isStripeDisputeId(value.disputeId) ||
    !isCommerceDocumentSegment(value.dropId) || !/^(?:ch|py)_[A-Za-z0-9_]+$/.test(value.chargeId) ||
    !/^pi_[A-Za-z0-9_]+$/.test(value.paymentIntentId) || value.chargeId.length > 256 ||
    value.paymentIntentId.length > 256 || !Number.isSafeInteger(value.disputeCreatedAt) ||
    value.disputeCreatedAt < 0 || !Number.isSafeInteger(value.recordedAtMs) || value.recordedAtMs < 0) {
    throw new StripeChargebackStoreError();
  }
}

async function existingRecord(db: D1Database, value: StripeChargebackRecord): Promise<boolean> {
  const row = await db.prepare(`SELECT drop_id, charge_id, payment_intent_id, dispute_created_at
    FROM stripe_order_disputes WHERE livemode = ? AND session_id = ? AND dispute_id = ?`)
    .bind(Number(value.livemode), value.sessionId, value.disputeId)
    .first<Record<string, unknown>>();
  if (!row) return false;
  if (row.drop_id !== value.dropId || row.charge_id !== value.chargeId ||
    row.payment_intent_id !== value.paymentIntentId || row.dispute_created_at !== value.disputeCreatedAt) {
    throw new StripeChargebackStoreError();
  }
  return true;
}

export async function recordStripeChargeback(
  db: D1Database,
  value: StripeChargebackRecord,
  write = true,
): Promise<'inserted' | 'existing' | 'unwritten'> {
  validateRecord(value);
  if (!write) return await existingRecord(db, value) ? 'existing' : 'unwritten';
  const result = await db.prepare(`INSERT INTO stripe_order_disputes (
      livemode, session_id, dispute_id, drop_id, charge_id, payment_intent_id,
      dispute_created_at, recorded_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(livemode, session_id, dispute_id) DO NOTHING
    RETURNING dispute_id`)
    .bind(Number(value.livemode), value.sessionId, value.disputeId, value.dropId,
      value.chargeId, value.paymentIntentId, value.disputeCreatedAt, value.recordedAtMs)
    .all<{ dispute_id: string }>();
  if (result.results.length === 1) return 'inserted';
  if (await existingRecord(db, value)) return 'existing';
  throw new StripeChargebackStoreError();
}

export async function loadStripeChargebackSessionIds(
  db: D1Database,
  dropId: string,
  sessionIds: readonly string[],
): Promise<Set<string>> {
  const ids = Array.from(new Set(sessionIds.filter(isStripeChargebackSessionId)));
  const matches = new Set<string>();
  if (!isCommerceDocumentSegment(dropId)) return matches;
  for (let index = 0; index < ids.length; index += 50) {
    const batch = ids.slice(index, index + 50);
    const result = await db.prepare(`SELECT DISTINCT session_id FROM stripe_order_disputes
      WHERE drop_id = ? AND session_id IN (${batch.map(() => '?').join(', ')})`)
      .bind(dropId, ...batch).all<{ session_id: string }>();
    for (const row of result.results) matches.add(row.session_id);
  }
  return matches;
}
