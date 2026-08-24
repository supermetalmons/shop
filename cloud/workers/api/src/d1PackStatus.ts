import type { PackStatusBreakdown } from '../../../../shared/contracts.js';
import {
  normalizePackStatusBreakdown,
  PACK_STATUS_SCHEMA_VERSION,
  type PackStatusEvent,
  type PackStatusEventIncrements,
  type PackStatusStatsFields,
} from '../../../../shared/packStatus.js';
import { shopDropById } from '../../../../shared/shopDomain.js';

export const D1_PACK_STATUS_CACHE_TTL_SECONDS = 15;

export type PackStatusD1Statement = {
  bind(...values: unknown[]): PackStatusD1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
};

export type PackStatusD1Database = {
  prepare(query: string): PackStatusD1Statement;
};

export type PackStatusReadSource = 'd1';

export type PackStatusRollout = {
  readSource: PackStatusReadSource;
  cacheGeneration: number;
};

export type D1PackStatusRecord = PackStatusStatsFields & {
  rebuiltAtMs: number | null;
  updatedAtMs: number;
};

type PackStatusRow = {
  drop_id: string;
  version: number;
  total_initial_supply: number;
  total_cards: number;
  cards_per_pack: number;
  unsealed_online: number;
  redeemed_irl_normal: number;
  redeemed_irl_stripe: number;
  redeemed_unsealed_cards: number;
  rebuilt_at_ms: number | null;
  updated_at_ms: number;
};

type RolloutRow = {
  read_source: string;
  cache_generation: number;
};

function positiveSafeInteger(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}

function nonnegativeSafeInteger(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : null;
}

function optionalTimestamp(value: unknown): number | null | undefined {
  if (value === null) return null;
  const normalized = nonnegativeSafeInteger(value);
  return normalized === null ? undefined : normalized;
}

function exactValue(value: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(value) &&
      value.length === expected.length &&
      expected.every((entry, index) => exactValue(value[index], entry));
  }
  if (expected && typeof expected === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const valueRecord = value as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    const valueKeys = Object.keys(valueRecord).sort();
    const expectedKeys = Object.keys(expectedRecord).sort();
    return valueKeys.length === expectedKeys.length &&
      valueKeys.every((key, index) => key === expectedKeys[index]) &&
      expectedKeys.every((key) => exactValue(valueRecord[key], expectedRecord[key]));
  }
  return Object.is(value, expected);
}

function parsePackStatusRow(row: PackStatusRow | null, dropId: string): D1PackStatusRecord | null {
  if (!row || row.drop_id !== dropId || row.version !== PACK_STATUS_SCHEMA_VERSION) return null;
  const totalInitialSupply = positiveSafeInteger(row.total_initial_supply);
  const totalCards = positiveSafeInteger(row.total_cards);
  const cardsPerPack = positiveSafeInteger(row.cards_per_pack);
  const unsealedOnline = nonnegativeSafeInteger(row.unsealed_online);
  const redeemedIrlNormal = nonnegativeSafeInteger(row.redeemed_irl_normal);
  const redeemedIrlStripe = nonnegativeSafeInteger(row.redeemed_irl_stripe);
  const redeemedUnsealedCards = nonnegativeSafeInteger(row.redeemed_unsealed_cards);
  const rebuiltAtMs = optionalTimestamp(row.rebuilt_at_ms);
  const updatedAtMs = nonnegativeSafeInteger(row.updated_at_ms);
  if (
    totalInitialSupply === null ||
    totalCards === null ||
    cardsPerPack === null ||
    totalCards !== totalInitialSupply * cardsPerPack ||
    unsealedOnline === null ||
    redeemedIrlNormal === null ||
    redeemedIrlStripe === null ||
    redeemedUnsealedCards === null ||
    rebuiltAtMs === undefined ||
    updatedAtMs === null
  ) return null;
  return {
    version: PACK_STATUS_SCHEMA_VERSION,
    dropId,
    totalInitialSupply,
    totalCards,
    cardsPerPack,
    unsealedOnline,
    redeemedIrlNormal,
    redeemedIrlStripe,
    redeemedUnsealedCards,
    rebuiltAtMs,
    updatedAtMs,
  };
}

export async function readPackStatusRollout(db: PackStatusD1Database): Promise<PackStatusRollout> {
  const row = await db.prepare(
    'SELECT read_source, cache_generation FROM pack_status_rollout WHERE singleton = 1',
  ).first<RolloutRow>();
  if (
    !row ||
    row.read_source !== 'd1' ||
    positiveSafeInteger(row.cache_generation) === null
  ) throw new Error('invalid_pack_status_rollout');
  return {
    readSource: row.read_source,
    cacheGeneration: Number(row.cache_generation),
  };
}

export async function readD1PackStatusRecord(
  db: PackStatusD1Database,
  dropId: string,
): Promise<D1PackStatusRecord | null> {
  const row = await db.prepare(
    `SELECT
      drop_id,
      version,
      total_initial_supply,
      total_cards,
      cards_per_pack,
      unsealed_online,
      redeemed_irl_normal,
      redeemed_irl_stripe,
      redeemed_unsealed_cards,
      rebuilt_at_ms,
      updated_at_ms
    FROM pack_status
    WHERE drop_id = ?`,
  ).bind(dropId).first<PackStatusRow>();
  return parsePackStatusRow(row, dropId);
}

export async function readD1PackStatus(
  db: PackStatusD1Database,
  dropId: string,
): Promise<PackStatusBreakdown | null> {
  const record = await readD1PackStatusRecord(db, dropId);
  if (!record) return null;
  return normalizePackStatusBreakdown(record, dropId, shopDropById(dropId)?.itemsPerBox);
}

export function parseD1PackStatusCache(
  value: unknown,
  dropId: string,
): PackStatusBreakdown | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const totalInitialSupply = positiveSafeInteger(record.totalInitialSupply);
  const totalCards = positiveSafeInteger(record.totalCards);
  const cardsPerPack = positiveSafeInteger(record.cardsPerPack);
  const unsealedOnline = nonnegativeSafeInteger(record.unsealedOnline);
  const redeemedIrlNormal = nonnegativeSafeInteger(record.redeemedIrlNormal);
  const redeemedIrlStripe = nonnegativeSafeInteger(record.redeemedIrlStripe);
  const redeemedUnsealedCards = nonnegativeSafeInteger(record.redeemedUnsealedCards);
  if (
    record.dropId !== dropId ||
    totalInitialSupply === null ||
    totalCards === null ||
    cardsPerPack === null ||
    totalCards !== totalInitialSupply * cardsPerPack ||
    unsealedOnline === null ||
    redeemedIrlNormal === null ||
    redeemedIrlStripe === null ||
    redeemedUnsealedCards === null
  ) return null;
  const expected = normalizePackStatusBreakdown({
    version: PACK_STATUS_SCHEMA_VERSION,
    dropId,
    totalInitialSupply,
    totalCards,
    cardsPerPack,
    unsealedOnline,
    redeemedIrlNormal,
    redeemedIrlStripe,
    redeemedUnsealedCards,
  }, dropId, shopDropById(dropId)?.itemsPerBox);
  return expected && exactValue(value, expected) ? expected : null;
}

function increment(event: PackStatusEvent, key: keyof PackStatusEventIncrements): number {
  const value = (event.increments as PackStatusEventIncrements)[key];
  if (value === undefined) return 0;
  const normalized = nonnegativeSafeInteger(value);
  if (normalized === null) throw new Error(`invalid_pack_status_increment_${key}`);
  return normalized;
}

export async function applyD1PackStatusEvent(
  db: PackStatusD1Database,
  event: PackStatusEvent,
  applyDelta = true,
): Promise<'applied' | 'duplicate'> {
  if (
    !event.dropId ||
    !event.eventKey ||
    positiveSafeInteger(event.quantity) === null ||
    nonnegativeSafeInteger(event.createdAtMs) === null
  ) throw new Error('invalid_pack_status_event');
  const unsealedOnline = increment(event, 'unsealedOnline');
  const redeemedIrlNormal = increment(event, 'redeemedIrlNormal');
  const redeemedIrlStripe = increment(event, 'redeemedIrlStripe');
  const redeemedUnsealedCards = increment(event, 'redeemedUnsealedCards');
  if (unsealedOnline + redeemedIrlNormal + redeemedIrlStripe + redeemedUnsealedCards <= 0) {
    throw new Error('invalid_pack_status_event_increments');
  }
  const result = await db.prepare(
    `INSERT INTO pack_status_events (
      drop_id,
      event_type,
      event_key,
      quantity,
      unsealed_online_delta,
      redeemed_irl_normal_delta,
      redeemed_irl_stripe_delta,
      redeemed_unsealed_cards_delta,
      delivery_id,
      checkout_session_id,
      box_asset_id,
      signature,
      apply_delta,
      created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(drop_id, event_type, event_key) DO NOTHING`,
  ).bind(
    event.dropId,
    event.type,
    event.eventKey,
    event.quantity,
    unsealedOnline,
    redeemedIrlNormal,
    redeemedIrlStripe,
    redeemedUnsealedCards,
    event.deliveryId ?? null,
    event.checkoutSessionId ?? null,
    event.boxAssetId ?? null,
    event.signature ?? null,
    applyDelta ? 1 : 0,
    event.createdAtMs,
  ).run();
  if (!result.success) throw new Error('pack_status_d1_event_insert_failed');
  return Number(result.meta.changes) > 0 ? 'applied' : 'duplicate';
}

export function packStatusCacheRequest(
  source: PackStatusReadSource,
  generation: number,
  dropId: string,
): Request {
  return new Request(
    `https://pack-status-cache.invalid/v1/${source}/${generation}/${encodeURIComponent(dropId)}`,
    { method: 'GET' },
  );
}
