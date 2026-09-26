import type { PreorderOrder } from '../../../../shared/preorders.js';
import { ProfileReadError } from './dataAccess.js';

export type StoredPreorder = PreorderOrder & {
  cluster: string;
  collection: string;
  requestId: string;
  preparedTransaction: string;
  signedTransaction: string | null;
  blockhash: string;
  blockhashContextSlot: number;
  lastValidBlockHeight: number;
  createdAtMs: number;
  revision: number;
};

function decode(row: Record<string, unknown> | null): StoredPreorder | null {
  if (!row) return null;
  return {
    orderId: String(row.order_id), preorderId: String(row.preorder_id), buyer: String(row.buyer),
    ethereumAddress: row.ethereum_address == null ? null : String(row.ethereum_address),
    cluster: String(row.cluster), collection: String(row.collection), requestId: String(row.request_id),
    cardIds: JSON.parse(String(row.card_ids_json)), assets: JSON.parse(String(row.assets_json)),
    status: row.status as PreorderOrder['status'], signature: row.signature === null ? null : String(row.signature),
    expiresAtMs: Number(row.expires_at_ms), createdAtMs: Number(row.created_at_ms), revision: Number(row.revision),
    preparedTransaction: String(row.prepared_transaction),
    signedTransaction: row.signed_transaction === null ? null : String(row.signed_transaction),
    blockhash: String(row.blockhash), blockhashContextSlot: Number(row.blockhash_context_slot),
    lastValidBlockHeight: Number(row.last_valid_block_height),
  };
}

export function publicPreorder(order: StoredPreorder): PreorderOrder {
  return {
    orderId: order.orderId, preorderId: order.preorderId, buyer: order.buyer, ethereumAddress: order.ethereumAddress, cardIds: order.cardIds,
    assets: order.assets, status: order.status, expiresAtMs: order.expiresAtMs, signature: order.signature,
  };
}

export async function listSucceededPreorderAssets(db: D1Database, buyer: string): Promise<Array<{ id: number; address: string; preorderId: string }>> {
  const result = await db.prepare(`SELECT preorder_id, assets_json FROM commerce_preorder_orders
    WHERE buyer = ? AND status = 'succeeded' ORDER BY created_at_ms DESC LIMIT 15`)
    .bind(buyer).all<{ preorder_id: string; assets_json: string }>();
  return result.results.flatMap((row) => (JSON.parse(row.assets_json) as PreorderOrder['assets'])
    .map((asset) => ({ ...asset, preorderId: row.preorder_id }))).slice(0, 15);
}

export class PreorderStore {
  constructor(private readonly db: D1Database) {}

  async get(orderId: string): Promise<StoredPreorder | null> {
    return decode(await this.db.prepare('SELECT * FROM commerce_preorder_orders WHERE order_id = ?').bind(orderId).first());
  }

  async request(preorderId: string, buyer: string, requestId: string): Promise<StoredPreorder | null> {
    return decode(await this.db.prepare(`SELECT * FROM commerce_preorder_orders
      WHERE preorder_id = ? AND buyer = ? AND request_id = ?`).bind(preorderId, buyer, requestId).first());
  }

  async active(preorderId: string, buyer: string): Promise<StoredPreorder | null> {
    return decode(await this.db.prepare(`SELECT * FROM commerce_preorder_orders
      WHERE preorder_id = ? AND buyer = ? AND status IN ('prepared', 'submitted')`).bind(preorderId, buyer).first());
  }

  async due(nowMs: number, limit = 20): Promise<StoredPreorder[]> {
    const result = await this.db.prepare(`SELECT * FROM commerce_preorder_orders
      WHERE status IN ('prepared', 'submitted') AND next_check_at_ms <= ?
      ORDER BY next_check_at_ms, order_id LIMIT ?`).bind(nowMs, limit).all<Record<string, unknown>>();
    return result.results.map((row) => decode(row)!);
  }

  async expirePrepared(nowMs: number): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE commerce_preorder_orders SET status = 'expired', updated_at_ms = ?, revision = revision + 1
        WHERE status = 'prepared' AND expires_at_ms <= ?`).bind(nowMs, nowMs),
      this.db.prepare(`DELETE FROM commerce_preorder_claims WHERE EXISTS (
        SELECT 1 FROM commerce_preorder_orders
        WHERE order_id = commerce_preorder_claims.order_id AND status = 'expired' AND signature IS NULL)`),
    ]);
  }

  async claims(cluster: string, collection: string): Promise<Array<{ id: number; status: 'reserved' | 'preordered'; orderId: string }>> {
    const result = await this.db.prepare(`SELECT claims.card_id, claims.order_id, orders.status
      FROM commerce_preorder_claims AS claims JOIN commerce_preorder_orders AS orders ON orders.order_id = claims.order_id
      WHERE claims.cluster = ? AND claims.collection = ?`).bind(cluster, collection).all<Record<string, unknown>>();
    return result.results.map((row) => ({ id: Number(row.card_id), orderId: String(row.order_id),
      status: row.status === 'succeeded' ? 'preordered' : 'reserved' }));
  }

  async reserve(order: StoredPreorder): Promise<StoredPreorder> {
    try {
      await this.db.batch([
        this.db.prepare(`INSERT INTO commerce_preorder_orders (
          order_id, preorder_id, cluster, collection, buyer, ethereum_address, request_id, card_ids_json, assets_json,
          status, prepared_transaction, blockhash, blockhash_context_slot, last_valid_block_height,
          expires_at_ms, created_at_ms, updated_at_ms, next_check_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(order.orderId, order.preorderId, order.cluster, order.collection, order.buyer, order.ethereumAddress, order.requestId,
            JSON.stringify(order.cardIds), JSON.stringify(order.assets), order.preparedTransaction, order.blockhash,
            order.blockhashContextSlot, order.lastValidBlockHeight, order.expiresAtMs, order.createdAtMs,
            order.createdAtMs, order.expiresAtMs),
        ...order.cardIds.map((id) => this.db.prepare(`INSERT INTO commerce_preorder_claims
          (cluster, collection, card_id, order_id) VALUES (?, ?, ?, ?)`).bind(order.cluster, order.collection, id, order.orderId)),
      ]);
      return order;
    } catch (error) {
      const existing = await this.request(order.preorderId, order.buyer, order.requestId);
      if (existing) return existing;
      if (error instanceof Error && /UNIQUE constraint/.test(error.message)) {
        throw new ProfileReadError('failed-precondition', 409, 'A selected card or your previous preorder is already reserved. Refresh and try again.');
      }
      throw error;
    }
  }

  async submit(order: StoredPreorder, signed: { transactionBase64: string; signature: string }, nowMs: number): Promise<StoredPreorder> {
    await this.db.prepare(`UPDATE commerce_preorder_orders SET status = 'submitted', signed_transaction = ?, signature = ?,
      updated_at_ms = ?, next_check_at_ms = ?, revision = revision + 1
      WHERE order_id = ? AND revision = ? AND status = 'prepared' AND expires_at_ms > ?`)
      .bind(signed.transactionBase64, signed.signature, nowMs, nowMs, order.orderId, order.revision, nowMs).run();
    return (await this.get(order.orderId))!;
  }

  async finish(order: StoredPreorder, status: 'succeeded' | 'failed' | 'expired' | 'cancelled', nowMs: number): Promise<StoredPreorder> {
    await this.db.batch([
      this.db.prepare(`UPDATE commerce_preorder_orders SET status = ?, updated_at_ms = ?, revision = revision + 1
        WHERE order_id = ? AND revision = ? AND status = ?`)
        .bind(status, nowMs, order.orderId, order.revision, order.status),
      this.db.prepare(`DELETE FROM commerce_preorder_claims WHERE order_id = ? AND EXISTS (
        SELECT 1 FROM commerce_preorder_orders WHERE order_id = ? AND status IN ('failed', 'expired', 'cancelled'))`)
        .bind(order.orderId, order.orderId),
    ]);
    return (await this.get(order.orderId))!;
  }

  async defer(order: StoredPreorder, nowMs: number): Promise<void> {
    await this.db.prepare(`UPDATE commerce_preorder_orders SET updated_at_ms = ?, next_check_at_ms = ?, revision = revision + 1
      WHERE order_id = ? AND revision = ? AND status = 'submitted'`)
      .bind(nowMs, nowMs + 15_000, order.orderId, order.revision).run();
  }
}
