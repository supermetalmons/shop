import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MiNoteEthereumSession } from '../../shared/miNoteAuth';
import { normalizeMiNoteAddress } from '../../shared/miNoteCards';
import { miNoteAuthApi, parseMiNoteSession } from '../lib/miNoteAuthApi';
import type { useMiNoteEthereumWallet } from './useMiNoteEthereumWallet';

const STORAGE_KEY = 'mons.shop.mi-note.ethereum-session';

function readSession(includeExpired = false): MiNoteEthereumSession | null {
  try { return parseMiNoteSession(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? 'null'), includeExpired ? 0 : Date.now()); }
  catch { return null; }
}

function saveSession(session: MiNoteEthereumSession | null): void {
  try {
    if (session) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export function useMiNoteVerification(
  active: boolean, preorderId: string, wallet: Pick<ReturnType<typeof useMiNoteEthereumWallet>, 'address' | 'provider'>,
  api = miNoteAuthApi,
) {
  const scope = useMemo(() => ({ preorderId, address: wallet.address, provider: wallet.provider }), [preorderId, wallet.address, wallet.provider]);
  const latest = useRef({ scope, active });
  latest.current = { scope, active };
  const generation = useRef(0);
  const previous = useRef<typeof scope | null>(null);
  const sessions = useRef(new Map<string, MiNoteEthereumSession>());
  const [state, setState] = useState<{
    scope: typeof scope; session: MiNoteEthereumSession | null; verifying: boolean; error: string | null;
  } | null>(null);
  const session = state?.scope === scope ? state.session : null;

  const revokeSession = useCallback((revokedScope: typeof scope, allCollections = false) => {
    const tokens = new Set<string>();
    const matches = (session: MiNoteEthereumSession) => session.address === revokedScope.address &&
      (allCollections || session.preorderId === revokedScope.preorderId);
    for (const session of sessions.current.values()) {
      if (matches(session)) tokens.add(session.token);
    }
    const stored = readSession(true);
    if (stored && matches(stored)) {
      saveSession(null);
      tokens.add(stored.token);
    }
    for (const token of tokens) {
      sessions.current.delete(token);
      void api.logout(token).catch(() => undefined);
    }
  }, [api]);

  const invalidate = useCallback(() => {
    if (latest.current.scope !== scope) return;
    generation.current += 1;
    revokeSession(scope);
    setState({ scope, session: null, verifying: false, error: null });
  }, [revokeSession, scope]);

  useEffect(() => {
    if (!active) {
      generation.current += 1;
      setState(current => current ? { ...current, verifying: false } : current);
    }
  }, [active]);

  useEffect(() => {
    generation.current += 1;
    const old = previous.current;
    if (old?.address && (old.address !== scope.address || old.provider !== scope.provider)) {
      revokeSession(old, true);
    }
    previous.current = scope;
    const restored = readSession();
    const session = scope.provider && restored?.address === scope.address && restored.preorderId === scope.preorderId ? restored : null;
    if (session) sessions.current.set(session.token, session);
    setState({ scope, session, verifying: false, error: null });
    return () => { generation.current += 1; };
  }, [revokeSession, scope]);

  useEffect(() => {
    if (!session) return;
    const expire = () => { if (session.expiresAtMs <= Date.now()) invalidate(); };
    const timeout = setTimeout(expire, Math.max(0, session.expiresAtMs - Date.now()));
    window.addEventListener('focus', expire);
    return () => { clearTimeout(timeout); window.removeEventListener('focus', expire); };
  }, [invalidate, session]);

  const verify = useCallback(async () => {
    if (!latest.current.active || !scope.address || !scope.provider) return;
    const attempt = ++generation.current;
    const current = () => latest.current.scope === scope && latest.current.active && generation.current === attempt;
    setState({ scope, session: null, verifying: true, error: null });
    try {
      const chain = await scope.provider.request({ method: 'eth_chainId' });
      const chainId = typeof chain === 'string' && /^0x[0-9a-f]+$/i.test(chain) ? Number(BigInt(chain)) : NaN;
      if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error('Couldn’t read your Ethereum wallet network.');
      if (!current()) return;
      const challenge = await api.challenge(scope.preorderId, scope.address, chainId);
      if (!current()) return;
      const hexMessage = `0x${Array.from(new TextEncoder().encode(challenge.message), byte => byte.toString(16).padStart(2, '0')).join('')}`;
      const signature = await scope.provider.request({ method: 'personal_sign', params: [hexMessage, scope.address] });
      if (!current()) return;
      if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) throw new Error('Your wallet returned an invalid signature.');
      const accounts = await scope.provider.request({ method: 'eth_accounts' });
      if (!current()) return;
      if (!Array.isArray(accounts) || normalizeMiNoteAddress(accounts[0]) !== scope.address) throw new Error('Your Ethereum account changed. Connect it again.');
      const verified = await api.verify(challenge.challengeId, signature);
      if (!current()) { void api.logout(verified.token).catch(() => undefined); return; }
      if (verified.address !== scope.address || verified.preorderId !== scope.preorderId) throw new Error('Ethereum verification does not match this wallet.');
      saveSession(verified);
      sessions.current.set(verified.token, verified);
      setState({ scope, session: verified, verifying: false, error: null });
    } catch (error) {
      if (!current()) return;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      setState({ scope, session: null, verifying: false, error: code === 4001
        ? 'Signature cancelled. Verify your Ethereum wallet when you’re ready.'
        : code === -32002 ? 'A signature request is already open. Check your Ethereum wallet.'
        : error instanceof Error ? error.message : 'Couldn’t verify your Ethereum wallet. Try again.' });
    }
  }, [api, scope]);

  return { ready: state?.scope === scope, session: session && session.expiresAtMs > Date.now() ? session : null,
    verifying: state?.scope === scope && state.verifying, error: state?.scope === scope ? state.error : null, verify, invalidate };
}

export type MiNoteVerification = ReturnType<typeof useMiNoteVerification>;
