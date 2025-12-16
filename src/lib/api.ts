import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseApp } from './firebase';
import { DeliverySelection, InventoryItem, MintStats, PreparedTxResponse, Profile, ProfileAddress } from '../types';

const region = import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || 'us-central1';
const functionsInstance = firebaseApp ? getFunctions(firebaseApp, region) : undefined;

async function callFunction<Req, Res>(name: string, data?: Req): Promise<Res> {
  if (!functionsInstance) throw new Error('Firebase client is not configured');
  const callable = httpsCallable<Req, Res>(functionsInstance, name);
  const result = await callable(data ?? ({} as Req));
  return result.data;
}

export async function fetchMintStats(): Promise<MintStats> {
  return callFunction<void, MintStats>('stats');
}

export async function fetchInventory(owner: string, token?: string): Promise<InventoryItem[]> {
  // token retained for backwards compatibility; callable uses current Firebase auth session.
  return callFunction<{ owner: string }, InventoryItem[]>('inventory', { owner });
}

export async function requestMintTx(
  owner: string,
  quantity: number,
  token?: string,
): Promise<PreparedTxResponse> {
  return callFunction<{ owner: string; quantity: number }, PreparedTxResponse>('prepareMintTx', {
    owner,
    quantity,
  });
}

export async function requestOpenBoxTx(
  owner: string,
  boxAssetId: string,
  token?: string,
): Promise<PreparedTxResponse> {
  return callFunction<{ owner: string; boxAssetId: string }, PreparedTxResponse>('prepareOpenBoxTx', {
    owner,
    boxAssetId,
  });
}

export async function saveEncryptedAddress(
  encrypted: string,
  country: string,
  label: string,
  token: string,
  hint: string,
  email?: string,
  countryCode?: string,
): Promise<ProfileAddress> {
  return callFunction<
    { encrypted: string; country: string; countryCode?: string; label: string; hint: string; email?: string },
    ProfileAddress
  >('saveAddress', { encrypted, country, countryCode, label, hint, email });
}

export async function requestDeliveryTx(
  owner: string,
  selection: DeliverySelection,
  token: string,
): Promise<PreparedTxResponse> {
  return callFunction<{ owner: string } & DeliverySelection, PreparedTxResponse>('prepareDeliveryTx', {
    owner,
    ...selection,
  });
}

export async function requestClaimTx(
  owner: string,
  code: string,
  token: string,
): Promise<PreparedTxResponse> {
  return callFunction<{ owner: string; code: string }, PreparedTxResponse>('prepareIrlClaimTx', { owner, code });
}

export async function finalizeClaimTx(
  owner: string,
  code: string,
  signature: string,
  token: string,
): Promise<{ recorded: boolean; signature: string }> {
  return callFunction<{ owner: string; code: string; signature: string }, { recorded: boolean; signature: string }>(
    'finalizeClaimTx',
    { owner, code, signature },
  );
}

export async function solanaAuth(
  wallet: string,
  message: string,
  signature: Uint8Array,
): Promise<{ customToken: string; profile: Profile }> {
  return callFunction<{ wallet: string; message: string; signature: number[] }, { customToken: string; profile: Profile }>(
    'solanaAuth',
    { wallet, message, signature: Array.from(signature) },
  );
}

export async function finalizeMintTx(
  owner: string,
  signature: string,
  token?: string,
): Promise<MintStats> {
  return callFunction<{ owner: string; signature: string }, MintStats>('finalizeMintTx', { owner, signature });
}

export async function finalizeDeliveryTx(
  owner: string,
  signature: string,
  orderId: string,
  token: string,
): Promise<{ recorded: boolean; signature: string; orderId: string }> {
  return callFunction<{ owner: string; signature: string; orderId: string }, { recorded: boolean; signature: string; orderId: string }>(
    'finalizeDeliveryTx',
    { owner, signature, orderId },
  );
}
