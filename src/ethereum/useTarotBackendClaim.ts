import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TarotBackendClaim, TarotRequest, TarotStatus } from '../../shared/ethereum/tarot';
import type { EthereumWallet } from './useEthereum111k';
import { ethereumAddress } from './wallet';
import { TarotApiError, tarotApi } from './tarotApi';
import { getInjectedEthereumProviderAvailability, listInjectedEthereumProviders } from '../wallet/injectedEthereumProviders';

type Intent = { requestId: string; recipient: string; operation: TarotBackendClaim | null };
type Options = {
  request: TarotRequest; status: TarotStatus | null; wallet: EthereumWallet; suspended: boolean; blocked: boolean;
  refresh: () => Promise<TarotStatus | null>; reportError: (error: TarotApiError) => void;
};
const memory = new WeakMap<Window, Map<string, Intent | null>>();
const terminal = (operation: TarotBackendClaim) => operation.state === 'failed' || operation.state === 'confirmed';

function readIntent(browser: Window, key: string): Intent | null {
  const cached = memory.get(browser);
  if (cached?.has(key)) return cached.get(key) ?? null;
  try {
    const value: unknown = JSON.parse(browser.sessionStorage.getItem(key) ?? 'null');
    if (value && typeof value === 'object' && 'requestId' in value && typeof value.requestId === 'string' &&
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.requestId) &&
      'recipient' in value && typeof value.recipient === 'string' && validRecipient(value.recipient)) {
      return { requestId: value.requestId, recipient: value.recipient, operation: null };
    }
  } catch {}
  return null;
}

function writeIntent(browser: Window, key: string, value: Intent | null) {
  let cache = memory.get(browser);
  if (!cache) memory.set(browser, cache = new Map());
  cache.set(key, value);
  try {
    if (value) browser.sessionStorage.setItem(key, JSON.stringify({ requestId: value.requestId, recipient: value.recipient }));
    else browser.sessionStorage.removeItem(key);
  } catch {}
}

function validRecipient(input: string): boolean {
  const value = input.trim();
  const address = ethereumAddress(value);
  if (address) return !/^0x0{40}$/.test(address);
  return value.length <= 255 && !/^0x/i.test(value) && !/\s/.test(value) && value.includes('.') && value.split('.').every(Boolean);
}

export function useTarotBackendClaim(options: Options) {
  const browser = useRef(window).current;
  const { request, status } = options;
  const identity = JSON.stringify(request);
  const scope = status?.config.contractAddress ?
    `mons.shop.tarot.backend:${status.config.chainId}:${status.config.contractAddress}:${request.tokenId}` : null;
  const latest = useRef(options);
  latest.current = options;
  const lifetime = useRef<AbortController | null>(null);
  const activeScope = useRef(scope);
  const intentRef = useRef<Intent | null>(null);
  const recoveryRequest = useRef<string | null>(null);
  const sending = useRef(false);
  const retryAt = useRef(0);
  const [intentState, setIntentState] = useState<{ scope: string | null; intent: Intent | null }>({ scope: null, intent: null });
  const [formVisible, setFormVisible] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const intent = scope ? intentState.scope === scope ? intentState.intent : readIntent(browser, scope) : null;
  const reported = status?.backendClaim;
  const operation = intent?.operation ?? (reported && (!intent || reported.requestId === intent.requestId || !terminal(reported)) ? reported : null);
  const pending = !status?.claimed && Boolean(operation ? operation.state !== 'failed' : intent);
  const providerAvailable = () => Boolean(latest.current.wallet.provider || latest.current.wallet.providerAvailability === 'available' ||
    getInjectedEthereumProviderAvailability() === 'available');
  const providerUnavailable = () => !providerAvailable() && (latest.current.wallet.providerAvailability === 'unavailable' ||
    getInjectedEthereumProviderAvailability() === 'unavailable');
  const intentPending = () => Boolean(intentRef.current && intentRef.current.operation?.state !== 'failed');
  const current = (controller: AbortController, expectedScope: string) => lifetime.current === controller &&
    !controller.signal.aborted && activeScope.current === expectedScope;
  const update = (key: string, next: Intent | null) => {
    writeIntent(browser, key, next);
    if (activeScope.current !== key) return;
    intentRef.current = next;
    setIntentState({ scope: key, intent: next });
  };
  const accept = (key: string, incoming: TarotBackendClaim) => {
    const previous = intentRef.current;
    if (previous && previous.requestId !== incoming.requestId && terminal(incoming)) return;
    const existing = previous?.requestId === incoming.requestId ? previous.operation : null;
    if (existing && (terminal(existing) && !terminal(incoming) || existing.transactionHash && !incoming.transactionHash)) return;
    update(key, { requestId: incoming.requestId,
      recipient: previous?.requestId === incoming.requestId ? previous.recipient : incoming.recipient, operation: incoming });
    setError(incoming.state === 'failed' || incoming.state === 'recovery-required' ? incoming.error ?? 'This claim could not be completed. Please try again later.' : null);
    if (incoming.state === 'failed' && providerUnavailable()) {
      if (recoveryRequest.current !== incoming.requestId) {
        recoveryRequest.current = incoming.requestId;
        setRecipient(previous?.recipient ?? incoming.recipient);
      }
      setFormVisible(true);
    } else setFormVisible(visible => visible && incoming.state === 'submitting' && incoming.transactionHash === null &&
      previous?.requestId === incoming.requestId);
  };

  useLayoutEffect(() => {
    activeScope.current = scope;
    intentRef.current = scope ? readIntent(browser, scope) : null;
    recoveryRequest.current = null;
    setIntentState({ scope, intent: intentRef.current });
    setFormVisible(false);
    setRecipient('');
    setError(null);
    setDiscovering(false);
    retryAt.current = 0;
    const controller = new AbortController();
    lifetime.current = controller;
    return () => { controller.abort(); sending.current = false; };
  }, [identity, scope]);

  useLayoutEffect(() => {
    if (!scope || !status) return;
    if (status.claimed) {
      update(scope, null);
      setFormVisible(false);
      setError(null);
    } else if (status.backendClaim) accept(scope, status.backendClaim);
  }, [scope, status]);

  useEffect(() => {
    if (formVisible && !pending && providerAvailable()) setFormVisible(false);
  }, [options.wallet.provider, options.wallet.providerAvailability, formVisible, pending]);

  const send = async (expected: Intent, key: string, controller: AbortController) => {
    if (sending.current || !current(controller, key) || retryAt.current > Date.now()) return;
    sending.current = true;
    try {
      const response = await tarotApi.claim({ ...latest.current.request, requestId: expected.requestId, recipient: expected.recipient }, controller.signal);
      if (!current(controller, key) || intentRef.current?.requestId !== expected.requestId) return;
      accept(key, response.backendClaim);
      retryAt.current = 0;
      void latest.current.refresh();
    } catch (cause) {
      if (!current(controller, key) || intentRef.current?.requestId !== expected.requestId) return;
      if (cause instanceof TarotApiError && (cause.field === 'recipient' || cause.claimAccepted === false)) {
        update(key, null);
        setRecipient(expected.recipient);
        setFormVisible(true);
        setError(cause.status === 401 || cause.status === 403 ? null : cause.message);
        if (cause.status === 401 || cause.status === 403 || cause.status === 429) latest.current.reportError(cause);
      } else {
        retryAt.current = cause instanceof TarotApiError ? cause.retryAt ?? Date.now() + 4_000 : Date.now() + 4_000;
        if (cause instanceof TarotApiError && (cause.status === 401 || cause.status === 403 || cause.status === 429)) {
          latest.current.reportError(cause);
        }
        setError(cause instanceof TarotApiError && cause.status === 429 ? cause.message : null);
        void latest.current.refresh();
      }
    } finally { if (lifetime.current === controller) sending.current = false; }
  };

  useEffect(() => {
    const controller = lifetime.current;
    if (!scope || !pending || !controller || options.suspended) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!active || !current(controller, scope)) return;
      if (document.visibilityState !== 'hidden' && !latest.current.suspended) {
        const snapshot = await latest.current.refresh();
        if (!active || !current(controller, scope)) return;
        if (snapshot?.claimed) return;
        const saved = intentRef.current;
        if (snapshot && saved && !saved.operation && (!snapshot.backendClaim ||
          terminal(snapshot.backendClaim) && snapshot.backendClaim.requestId !== saved.requestId) && retryAt.current <= Date.now()) {
          await send(saved, scope, controller);
        } else if (snapshot?.backendClaim && saved?.operation && !terminal(saved.operation) &&
          terminal(snapshot.backendClaim) && snapshot.backendClaim.requestId !== saved.requestId && retryAt.current <= Date.now()) {
          try {
            const history = await tarotApi.status({ ...latest.current.request, requestId: saved.requestId }, controller.signal);
            if (active && current(controller, scope) && intentRef.current?.requestId === saved.requestId && !history.claimed &&
              history.config.chainId === snapshot.config.chainId && history.config.contractAddress === snapshot.config.contractAddress &&
              history.backendClaim?.requestId === saved.requestId) {
              accept(scope, history.backendClaim);
              retryAt.current = 0;
            }
          } catch (cause) {
            if (active && current(controller, scope) && intentRef.current?.requestId === saved.requestId) {
              retryAt.current = cause instanceof TarotApiError ? cause.retryAt ?? Date.now() + 4_000 : Date.now() + 4_000;
              if (cause instanceof TarotApiError && (cause.status === 401 || cause.status === 403 || cause.status === 429)) {
                latest.current.reportError(cause);
              }
              setError(cause instanceof TarotApiError && cause.status === 429 ? cause.message : null);
            }
          }
        }
      }
      if (active && current(controller, scope)) timer = setTimeout(() => { void poll(); }, Math.max(4_000, retryAt.current - Date.now()));
    };
    timer = setTimeout(() => { void poll(); }, 4_000);
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [identity, scope, pending, options.suspended]);

  const claim = (walletClaim: () => void) => {
    if (latest.current.blocked || pending || intentPending() || discovering || latest.current.suspended || !latest.current.status?.config.enabled) return;
    if (providerAvailable()) { walletClaim(); return; }
    if (providerUnavailable()) {
      setError(null);
      setFormVisible(true);
      return;
    }
    const controller = lifetime.current;
    setDiscovering(true);
    void listInjectedEthereumProviders().then(() => {
      if (!controller || controller.signal.aborted || latest.current.suspended || latest.current.blocked) return;
      if (providerAvailable()) walletClaim();
      else if (getInjectedEthereumProviderAvailability() === 'unavailable') { setError(null); setFormVisible(true); }
    }).catch(() => {}).finally(() => { if (controller && !controller.signal.aborted) setDiscovering(false); });
  };

  const submitRecipient = () => {
    const controller = lifetime.current;
    if (!scope || !controller || !formVisible || pending || intentPending() || sending.current || latest.current.blocked || latest.current.suspended) return;
    if (providerAvailable()) { setFormVisible(false); setError(null); return; }
    if (!validRecipient(recipient)) { setError('Enter a valid Ethereum address or ENS name.'); return; }
    const next: Intent = { requestId: crypto.randomUUID(), recipient: recipient.trim(), operation: null };
    setError(null);
    retryAt.current = 0;
    update(scope, next);
    void send(next, scope, controller);
  };

  return { claim, submitRecipient, formVisible: formVisible && (!operation?.transactionHash || operation.state === 'failed') && !status?.claimed, recipient,
    setRecipient: (value: string) => { setRecipient(value); setError(null); },
    recipientValid: validRecipient(recipient), error, pending, discovering,
    transactionHash: pending ? operation?.transactionHash ?? null : null };
}
