import { DeliverySelection, InventoryItem, MintStats, PreparedTxResponse, Profile, ProfileAddress } from '../types';

const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
const defaultBase = projectId ? `https://us-central1-${projectId}.cloudfunctions.net` : '';
const BASE_URL = import.meta.env.VITE_FUNCTIONS_BASE_URL || defaultBase;

interface ApiError {
  error: string;
  status?: number;
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!BASE_URL) throw new Error('Missing VITE_FUNCTIONS_BASE_URL or project id');
  const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    ...init,
  });

  const text = await res.text();
  let data: T | ApiError;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Unexpected response from ${path}: ${text}`);
  }

  if (!res.ok) {
    const message = (data as ApiError).error || res.statusText;
    throw new Error(`${message} (${res.status})`);
  }

  return data as T;
}

export async function fetchMintStats(): Promise<MintStats> {
  return apiFetch<MintStats>('/stats');
}

export async function fetchInventory(owner: string, token?: string): Promise<InventoryItem[]> {
  return apiFetch<InventoryItem[]>(`/inventory?owner=${encodeURIComponent(owner)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
}

export async function requestMintTx(
  owner: string,
  quantity: number,
  token?: string,
): Promise<PreparedTxResponse> {
  return apiFetch<PreparedTxResponse>('/prepareMintTx', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: JSON.stringify({ owner, quantity }),
  });
}

export async function requestOpenBoxTx(
  owner: string,
  boxAssetId: string,
  token?: string,
): Promise<PreparedTxResponse> {
  return apiFetch<PreparedTxResponse>('/prepareOpenBoxTx', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: JSON.stringify({ owner, boxAssetId }),
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
  return apiFetch<ProfileAddress>('/saveAddress', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ encrypted, country, countryCode, label, hint, email }),
  });
}

export async function requestDeliveryTx(
  owner: string,
  selection: DeliverySelection,
  token: string,
): Promise<PreparedTxResponse> {
  return apiFetch<PreparedTxResponse>('/prepareDeliveryTx', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ owner, ...selection }),
  });
}

export async function requestClaimTx(
  owner: string,
  code: string,
  token: string,
): Promise<PreparedTxResponse> {
  return apiFetch<PreparedTxResponse>('/prepareIrlClaimTx', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ owner, code }),
  });
}

export async function finalizeClaimTx(
  owner: string,
  code: string,
  signature: string,
  token: string,
): Promise<{ recorded: boolean; signature: string }> {
  return apiFetch('/finalizeClaimTx', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ owner, code, signature }),
  });
}

export async function solanaAuth(
  wallet: string,
  message: string,
  signature: Uint8Array,
): Promise<{ customToken: string; profile: Profile }> {
  return apiFetch('/solanaAuth', {
    method: 'POST',
    body: JSON.stringify({ wallet, message, signature: Array.from(signature) }),
  });
}

export async function finalizeMintTx(
  owner: string,
  signature: string,
  token?: string,
): Promise<MintStats> {
  return apiFetch('/finalizeMintTx', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: JSON.stringify({ owner, signature }),
  });
}

export async function finalizeDeliveryTx(
  owner: string,
  signature: string,
  orderId: string,
  token: string,
): Promise<{ recorded: boolean; signature: string; orderId: string }> {
  return apiFetch('/finalizeDeliveryTx', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ owner, signature, orderId }),
  });
}
