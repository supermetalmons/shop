import type { DropFamily } from '../config/deployment';
import type { InventoryItem } from '../types';
import { ADMIN_WALLETS } from './fulfillmentAccess';

type EligibilityItem = Pick<InventoryItem, 'dropId' | 'kind'>;

export type PendingAdminIrlRedeemFinalize = {
  wallet: string;
  dropId: string;
  requestId: string;
  transferSignature: string;
  itemIds: string[];
  createdAt: number;
  updatedAt: number;
};

const ADMIN_IRL_REDEEM_PENDING_FINALIZE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING_ADMIN_IRL_REDEEMS = 20;
const ADMIN_IRL_REDEEM_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const ADMIN_IRL_REDEEM_TRANSFER_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/;

function pendingAdminIrlRedeemFinalizeKey(wallet?: string) {
  return wallet ? `monsPendingAdminIrlRedeems:${wallet}` : 'monsPendingAdminIrlRedeems:disconnected';
}

// Preserve the request id and transfer signature for support if immediate finalization does not complete.
function normalizePendingAdminIrlRedeemFinalize(
  entry: unknown,
  now = Date.now(),
): PendingAdminIrlRedeemFinalize | null {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry as Partial<PendingAdminIrlRedeemFinalize>;
  const wallet = typeof raw.wallet === 'string' ? raw.wallet.trim() : '';
  const dropId = typeof raw.dropId === 'string' ? raw.dropId.trim() : '';
  const requestId = typeof raw.requestId === 'string' ? raw.requestId.trim() : '';
  const transferSignature = typeof raw.transferSignature === 'string' ? raw.transferSignature.trim() : '';
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt;
  if (!wallet || !dropId || !ADMIN_IRL_REDEEM_REQUEST_ID_RE.test(requestId)) return null;
  if (!ADMIN_IRL_REDEEM_TRANSFER_SIGNATURE_RE.test(transferSignature)) return null;
  if (now - createdAt > ADMIN_IRL_REDEEM_PENDING_FINALIZE_TTL_MS) return null;
  const itemIds = Array.isArray(raw.itemIds)
    ? Array.from(new Set(raw.itemIds.map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean)))
    : [];
  return { wallet, dropId, requestId, transferSignature, itemIds, createdAt, updatedAt };
}

function normalizePendingAdminIrlRedeemFinalizes(
  entries: unknown[],
  wallet: string,
  now = Date.now(),
): PendingAdminIrlRedeemFinalize[] {
  const byRequest = new Map<string, PendingAdminIrlRedeemFinalize>();
  entries.forEach((entry) => {
    const normalized = normalizePendingAdminIrlRedeemFinalize(entry, now);
    if (!normalized || normalized.wallet !== wallet) return;
    const previous = byRequest.get(normalized.requestId);
    if (!previous || previous.updatedAt < normalized.updatedAt) {
      byRequest.set(normalized.requestId, normalized);
    }
  });
  return Array.from(byRequest.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_PENDING_ADMIN_IRL_REDEEMS);
}

function loadPendingAdminIrlRedeems(wallet?: string): PendingAdminIrlRedeemFinalize[] {
  if (typeof window === 'undefined' || !wallet) return [];
  try {
    const raw = window.localStorage?.getItem(pendingAdminIrlRedeemFinalizeKey(wallet));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizePendingAdminIrlRedeemFinalizes(parsed, wallet);
  } catch {
    return [];
  }
}

function persistPendingAdminIrlRedeems(wallet: string, entries: PendingAdminIrlRedeemFinalize[]) {
  if (typeof window === 'undefined' || !wallet) return;
  try {
    const normalized = normalizePendingAdminIrlRedeemFinalizes(entries, wallet);
    const key = pendingAdminIrlRedeemFinalizeKey(wallet);
    if (!normalized.length) window.localStorage?.removeItem(key);
    else window.localStorage?.setItem(key, JSON.stringify(normalized));
  } catch {
    // ignore storage failures
  }
}

export function rememberPendingAdminIrlRedeem(
  wallet: string,
  entry: Omit<PendingAdminIrlRedeemFinalize, 'wallet' | 'createdAt' | 'updatedAt'>,
) {
  const now = Date.now();
  const normalized = normalizePendingAdminIrlRedeemFinalize(
    {
      ...entry,
      wallet,
      createdAt: now,
      updatedAt: now,
    },
    now,
  );
  if (!normalized) return;
  const existing = loadPendingAdminIrlRedeems(wallet).filter((item) => item.requestId !== normalized.requestId);
  persistPendingAdminIrlRedeems(wallet, [normalized, ...existing]);
}

export function forgetPendingAdminIrlRedeem(wallet: string, requestId: string) {
  const normalizedRequestId = String(requestId || '').trim();
  if (!wallet || !normalizedRequestId) return;
  const next = loadPendingAdminIrlRedeems(wallet).filter((entry) => entry.requestId !== normalizedRequestId);
  persistPendingAdminIrlRedeems(wallet, next);
}

export function canAdminIrlRedeemSelection(args: {
  wallet?: string | null;
  isSignedInWallet: boolean;
  selectedCount: number;
  selectedDropIds: string[];
  selectedItems: readonly EligibilityItem[];
  deliverableItems: readonly EligibilityItem[];
  selectionOwner?: string | null;
  selectedDropFamily?: DropFamily;
  hasAdminAccess?: (wallet: string | null | undefined) => boolean;
}): boolean {
  const hasAdminAccess = args.hasAdminAccess || ((wallet) => Boolean(wallet && ADMIN_WALLETS.has(wallet)));
  if (!args.wallet || !args.isSignedInWallet || !hasAdminAccess(args.wallet)) return false;
  if (!args.selectionOwner || args.selectionOwner !== args.wallet) return false;
  if (args.selectedCount <= 0 || args.deliverableItems.length !== args.selectedCount) return false;
  if (args.selectedItems.length !== args.selectedCount) return false;
  if (args.selectedDropIds.length !== 1) return false;
  if (args.selectedDropFamily !== 'card_nft_2') return false;
  return args.deliverableItems.every((item) => item.kind === 'box');
}
