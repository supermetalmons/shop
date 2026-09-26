import { MI_NOTE_SESSION_HEADER, type MiNoteEthereumSession } from '../../shared/miNoteAuth';
import { normalizeMiNoteAddress } from '../../shared/miNoteCards';
import { AUTHENTICATED_API_ORIGIN } from './authenticatedApiOrigin';
import { ProfileApiError } from '../api/transport';
import { readMiNoteResponse } from './miNoteResponse';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function request(action: string, body: unknown, token?: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${AUTHENTICATED_API_ORIGIN}/mi-note-cards/auth/${action}`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Mons-CSRF': '1', ...(token ? { [MI_NOTE_SESSION_HEADER]: token } : {}) },
      body: JSON.stringify(body),
    });
    const payload = await readMiNoteResponse(response, controller.signal, 16_384);
    if (!response.ok) {
      const error = record(payload) && record(payload.error) ? payload.error : null;
      throw new ProfileApiError({
        code: typeof error?.code === 'string' ? error.code : 'unavailable', status: response.status,
        message: typeof error?.message === 'string' ? error.message : 'Ethereum verification failed. Try again.',
      });
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export function parseMiNoteSession(value: unknown, nowMs = Date.now()): MiNoteEthereumSession | null {
  if (!record(value) || typeof value.token !== 'string' || !value.token || value.token.length > 512 ||
    typeof value.preorderId !== 'string' || !Number.isSafeInteger(value.expiresAtMs) ||
    Number(value.expiresAtMs) <= nowMs) return null;
  const address = normalizeMiNoteAddress(value.address);
  return address ? { token: value.token, address, preorderId: value.preorderId, expiresAtMs: Number(value.expiresAtMs) } : null;
}

export const miNoteAuthApi = {
  async challenge(preorderId: string, address: string, chainId: number) {
    const payload = await request('challenge', { preorderId, address, chainId });
    if (!record(payload) || typeof payload.challengeId !== 'string' || !payload.challengeId ||
      typeof payload.message !== 'string' || !payload.message || !Number.isSafeInteger(payload.expiresAtMs) ||
      Number(payload.expiresAtMs) <= Date.now()) throw new Error('Invalid Ethereum verification challenge.');
    return { challengeId: payload.challengeId, message: payload.message, expiresAtMs: Number(payload.expiresAtMs) };
  },
  async verify(challengeId: string, signature: string) {
    const session = parseMiNoteSession(await request('verify', { challengeId, signature }));
    if (!session) throw new Error('Invalid Ethereum verification session.');
    return session;
  },
  async logout(token: string) { await request('logout', {}, token); },
};
