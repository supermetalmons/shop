import { z } from 'zod';
import type { ProfileAddress } from '../../../../shared/contracts.js';
import { createProfileAddressId, PROFILE_ADDRESS_ID_PATTERN } from '../../../../shared/profileD1.js';
import { normalizeCountryCode } from '../../../../shared/countryNormalization.js';
import { isShipmentHistoryCursor, MAX_SHIPMENT_PAGE_LIMIT, type ShipmentHistoryCursor } from '../../../../shared/shipmentHistory.js';
import { EthereumApiError, readEthereumBody } from './ethereumError.js';
import type { EthereumContext } from './ethereumRuntime.js';
import { verifyEthereumSession } from './ethereumAuth.js';
import { loadEthereumProfile, loadEthereumProfileAddress, saveEthereumProfileAddress } from './ethereumProfileStore.js';
import { ProfileAddressConflictError } from './profilePersistence.js';
import { D1CommerceRepository } from './commerceRepository.js';

const addressSchema = z.object({
  id: z.string().regex(PROFILE_ADDRESS_ID_PATTERN).optional(),
  encrypted: z.string().min(1).max(4096), country: z.string().min(1).max(64),
  countryCode: z.string().max(32).optional(), hint: z.string().max(256),
  email: z.string().email().max(254).optional(),
}).strict();

function shipmentPage(request: Request, wallet: string, dropId: string): { limit: number; startAfter?: ShipmentHistoryCursor } {
  const params = new URL(request.url).searchParams;
  const invalid = () => new EthereumApiError('invalid-argument', 'Invalid shipment pagination.');
  if ([...params.keys()].some((key) => key !== 'limit' && key !== 'cursor') ||
    params.getAll('limit').length > 1 || params.getAll('cursor').length > 1) throw invalid();
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? MAX_SHIPMENT_PAGE_LIMIT : Number(rawLimit);
  if ((rawLimit !== null && !/^[1-9][0-9]{0,2}$/.test(rawLimit)) || limit > MAX_SHIPMENT_PAGE_LIMIT) throw invalid();
  const rawCursor = params.get('cursor');
  if (rawCursor === null) return { limit };
  if (rawCursor.length > 2048) throw invalid();
  let cursor: unknown;
  try { cursor = JSON.parse(rawCursor); } catch { throw invalid(); }
  if (!isShipmentHistoryCursor(cursor, wallet) || cursor.documentPath.split('/')[1] !== dropId) throw invalid();
  return { limit, startAfter: cursor };
}

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
    return new D1CommerceRepository(context.env.COMMERCE_DB).queryShipmentHistoryPage({
      ...shipmentPage(request, session.wallet, context.config.dropId),
      owner: session.wallet, dropId: context.config.dropId, allowPaused: true,
    });
  }
  return loadEthereumProfile(context.env.OPS_DB, session.wallet, context.signal);
}
