import { z } from 'zod';
import type { ProfileAddress } from '../../../../shared/contracts.js';
import { createProfileAddressId, PROFILE_ADDRESS_ID_PATTERN } from '../../../../shared/profileD1.js';
import { normalizeCountryCode } from '../../../../shared/countryNormalization.js';
import { parseDeliveryOrderSummary } from '../../../../shared/deliveryOrderSummary.js';
import { EthereumApiError, readEthereumBody } from './ethereumError.js';
import type { EthereumContext } from './ethereumRuntime.js';
import { verifyEthereumSession } from './ethereumAuth.js';

const addressSchema = z.object({
  id: z.string().regex(PROFILE_ADDRESS_ID_PATTERN).optional(),
  encrypted: z.string().min(1).max(4096), country: z.string().min(1).max(64),
  countryCode: z.string().max(32).optional(), hint: z.string().max(256),
  email: z.string().email().max(254).optional(),
}).strict();

export async function loadEthereumAddress(context: EthereumContext, wallet: string, id: string): Promise<ProfileAddress> {
  const row = await context.env.OPS_DB.prepare('SELECT address_json FROM ethereum_profile_addresses WHERE wallet = ? AND address_id = ?')
    .bind(wallet, id).first<{ address_json: string }>();
  if (!row) throw new EthereumApiError('not-found', 'Shipping address not found.');
  return JSON.parse(row.address_json) as ProfileAddress;
}

export async function ethereumProfile(request: Request, context: EthereumContext, path: string): Promise<unknown> {
  const session = await verifyEthereumSession(request, context);
  if (request.method === 'POST') {
    const body = await readEthereumBody(request, context.signal, addressSchema);
    const address: ProfileAddress = {
      ...body, id: body.id || createProfileAddressId(),
      countryCode: normalizeCountryCode(body.countryCode || body.country) || body.countryCode,
    };
    await context.env.OPS_DB.batch([
      context.env.OPS_DB.prepare(`INSERT INTO ethereum_profiles (wallet, email, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET
        email = COALESCE(excluded.email, ethereum_profiles.email), updated_at_ms = excluded.updated_at_ms`)
        .bind(session.wallet, address.email || null, context.nowMs, context.nowMs),
      context.env.OPS_DB.prepare(`INSERT OR IGNORE INTO ethereum_profile_addresses (wallet, address_id, address_json, created_at_ms)
        VALUES (?, ?, ?, ?)`).bind(session.wallet, address.id, JSON.stringify(address), context.nowMs),
    ]);
    const saved = await loadEthereumAddress(context, session.wallet, address.id);
    if (JSON.stringify(saved) !== JSON.stringify(address)) throw new EthereumApiError('failed-precondition', 'This saved address cannot be changed. Save a new address instead.');
    return { address: saved };
  }
  if (path.endsWith('/shipments')) {
    const result = await context.env.COMMERCE_DB.prepare(`SELECT document_id, document_json FROM commerce_documents
      WHERE document_kind = 'delivery_order' AND drop_id = ? AND owner = ?
      ORDER BY processed_at_seconds DESC, document_id DESC LIMIT 100`)
      .bind(context.config.dropId, session.wallet).all<{ document_id: string; document_json: string }>();
    const orders = result.results.flatMap((row) => {
      const summary = parseDeliveryOrderSummary({ ...JSON.parse(row.document_json), deliveryId: Number(row.document_id), dropId: context.config.dropId });
      return summary ? [summary] : [];
    });
    return { orders };
  }
  const [profile, addresses] = await Promise.all([
    context.env.OPS_DB.prepare('SELECT email FROM ethereum_profiles WHERE wallet = ?').bind(session.wallet).first<{ email: string | null }>(),
    context.env.OPS_DB.prepare('SELECT address_json FROM ethereum_profile_addresses WHERE wallet = ? ORDER BY created_at_ms DESC LIMIT 100')
      .bind(session.wallet).all<{ address_json: string }>(),
  ]);
  return { wallet: session.wallet, ...(profile?.email ? { email: profile.email } : {}), addresses: addresses.results.map((row) => JSON.parse(row.address_json)) };
}
