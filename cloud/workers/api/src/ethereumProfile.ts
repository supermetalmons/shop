import { z } from 'zod';
import type { ProfileAddress } from '../../../../shared/contracts.js';
import { createProfileAddressId, PROFILE_ADDRESS_ID_PATTERN } from '../../../../shared/profileD1.js';
import { normalizeCountryCode } from '../../../../shared/countryNormalization.js';
import { parseDeliveryOrderSummary } from '../../../../shared/deliveryOrderSummary.js';
import { EthereumApiError, readEthereumBody } from './ethereumError.js';
import type { EthereumContext } from './ethereumRuntime.js';
import { verifyEthereumSession } from './ethereumAuth.js';
import { loadEthereumProfile, loadEthereumProfileAddress, saveEthereumProfileAddress } from './ethereumProfileStore.js';
import { ProfileAddressConflictError } from './profilePersistence.js';

const addressSchema = z.object({
  id: z.string().regex(PROFILE_ADDRESS_ID_PATTERN).optional(),
  encrypted: z.string().min(1).max(4096), country: z.string().min(1).max(64),
  countryCode: z.string().max(32).optional(), hint: z.string().max(256),
  email: z.string().email().max(254).optional(),
}).strict();

export async function loadEthereumAddress(context: EthereumContext, wallet: string, id: string): Promise<ProfileAddress> {
  const address = await loadEthereumProfileAddress(context.env.OPS_DB, wallet, id, context.signal);
  if (!address) throw new EthereumApiError('not-found', 'Shipping address not found.');
  return address;
}

export async function ethereumProfile(request: Request, context: EthereumContext, path: string): Promise<unknown> {
  const session = await verifyEthereumSession(request, context);
  if (request.method === 'POST') {
    const body = await readEthereumBody(request, context.signal, addressSchema);
    const address: ProfileAddress = {
      ...body, id: body.id || createProfileAddressId(),
      countryCode: normalizeCountryCode(body.countryCode || body.country) || body.countryCode,
    };
    try {
      const saved = await saveEthereumProfileAddress(context.env.OPS_DB, {
        ...address, wallet: session.wallet, createdAtMs: context.nowMs, updatedAtMs: context.nowMs,
      }, context.signal);
      return { address: saved };
    } catch (error) {
      if (error instanceof ProfileAddressConflictError) throw new EthereumApiError('failed-precondition', error.message);
      throw error;
    }
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
  return loadEthereumProfile(context.env.OPS_DB, session.wallet, context.signal);
}
