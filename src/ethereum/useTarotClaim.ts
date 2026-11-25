import { useCallback, useEffect, useRef, useState } from 'react';
import type { TarotConfig, TarotRequest, TarotStatus } from '../../shared/ethereum/tarot';
import { tarotChainId } from '../../shared/ethereum/tarot';
import type { EthereumWallet } from './useEthereum111k';
import { captureEthereumWalletActionConfig, ethereumWalletActionChanged, useEthereumWalletAction } from './useEthereumWalletAction';
import { ethereumAddress, ethereumOperation, ethereumWalletError } from './wallet';
import { TarotApiError, tarotApi } from './tarotApi';
import { readSavedNfcCode, settleNfcScan } from './nfcScan';
import { abortableEthereumOperation } from './operationReconciliation';
import { definiteEthereumSubmissionRejection } from './dropOperations';

type PendingClaim = { id: string; wallet: string; transactionHash: string | null; deadline: number };
type ChainObservation = { blockNumber: number; blockHash: string; claimed: boolean };
const pendingMemory = new WeakMap<Window, Map<string, { value: PendingClaim | null; baseline: string | null }>>();
const INITIAL_RETRY_DELAYS = [2_000, 4_000, 8_000, 16_000, 30_000];
const CLAIMS_UNAVAILABLE = 'Tarot claims are unavailable.';
const recoveryKey = (config: TarotConfig, tokenId: number) => `mons.shop.tarot.pending:${config.chainId}:${config.contractAddress}:${tokenId}`;
const deploymentKey = (config: TarotConfig) => `${config.chainId}:${config.contractAddress}`;

function isCredentialDenial(error: unknown): boolean {
  return error instanceof TarotApiError && (error.status === 401 || error.status === 403);
}

function canRetryInitialValidation(error: unknown): boolean {
  return error instanceof TarotApiError ? error.status === 429 || error.status >= 500 && error.status < 600 :
    error instanceof TypeError || error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function cachePending(browserWindow: Window, key: string, value: PendingClaim | null, baseline: string | null) {
  let entries = pendingMemory.get(browserWindow);
  if (!entries) pendingMemory.set(browserWindow, entries = new Map());
  entries.set(key, { value, baseline });
}

function readPending(browserWindow: Window, config: TarotConfig, tokenId: number): PendingClaim | null {
  const key = recoveryKey(config, tokenId);
  const cached = pendingMemory.get(browserWindow)?.get(key);
  let stored: string | null;
  try { stored = browserWindow.sessionStorage.getItem(key); } catch { return cached?.value ?? null; }
  if (cached && stored === cached.baseline) return cached.value;
  pendingMemory.get(browserWindow)?.delete(key);
  try {
    const value: unknown = JSON.parse(stored ?? 'null');
    if (value && typeof value === 'object' && 'wallet' in value && 'transactionHash' in value &&
      'id' in value && typeof value.id === 'string' && value.id &&
      'deadline' in value && typeof value.deadline === 'number' && Number.isSafeInteger(value.deadline) && value.deadline > 0 &&
      (value.transactionHash === null || typeof value.transactionHash === 'string' && /^0x[0-9a-f]{64}$/.test(value.transactionHash)) && ethereumAddress(value.wallet)) {
      const pending = { id: value.id, wallet: ethereumAddress(value.wallet)!, transactionHash: value.transactionHash, deadline: value.deadline };
      cachePending(browserWindow, key, pending, stored);
      return pending;
    }
  } catch {}
  return null;
}

function rememberPending(browserWindow: Window, config: TarotConfig, tokenId: number, value: PendingClaim | null): void {
  const key = recoveryKey(config, tokenId);
  let baseline = pendingMemory.get(browserWindow)?.get(key)?.baseline ?? null;
  try { baseline = browserWindow.sessionStorage.getItem(key); } catch {}
  const serialized = value ? JSON.stringify(value) : null;
  try {
    if (serialized !== null) browserWindow.sessionStorage.setItem(key, serialized);
    else browserWindow.sessionStorage.removeItem(key);
    if (browserWindow.sessionStorage.getItem(key) === serialized) {
      if (value) cachePending(browserWindow, key, value, serialized);
      else pendingMemory.get(browserWindow)?.delete(key);
      return;
    }
  } catch {}
  cachePending(browserWindow, key, value, baseline);
}

export function useTarotClaim(request: TarotRequest, wallet: EthereumWallet, suspended = false) {
  const browserWindow = useRef(window).current;
  const identity = JSON.stringify(request);
  const latest = useRef({ request, wallet, identity, suspended });
  latest.current = { request, wallet, identity, suspended };
  const lifecycle = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingClaim | null>(null);
  const walletWait = useRef<{ id: string | null; scope: string; controller: AbortController } | null>(null);
  const connectingClaim = useRef(false);
  const retryAt = useRef(0);
  const loading = useRef(false);
  const deployment = useRef<string | null>(null);
  const chainObservation = useRef<ChainObservation | null>(null);
  const reconciliationEpoch = useRef(0);
  const initialValidation = useRef({ succeeded: false, failures: 0, permanentFailure: false });
  const [retryDeadline, setRetryDeadline] = useState<number | null>(null);
  const [state, setState] = useState<{ identity: string; status: TarotStatus | null; loading: boolean; error: string | null }>({
    identity, status: null, loading: true, error: null,
  });
  const [pending, setPending] = useState<PendingClaim | null>(null);
  const [claimFeedback, setClaimFeedback] = useState<{ identity: string; error: string | null; transientConfirmation?: boolean } | null>(null);
  const currentStatus = state.identity === identity ? state.status : null;
  const current = () => lifecycle.current !== null && !lifecycle.current.signal.aborted && latest.current.identity === identity;

  const updatePending = (config: TarotConfig, value: PendingClaim | null) => {
    rememberPending(browserWindow, config, request.tokenId, value);
    if (!current() || deployment.current !== deploymentKey(config)) return;
    const previous = pendingRef.current;
    pendingRef.current = value;
    setPending(value);
    if (!value) setClaimFeedback(feedback => feedback?.identity === identity && feedback.transientConfirmation ? null : feedback);
    if (!value && previous && walletWait.current?.id === previous.id) {
      walletWait.current.controller.abort(new Error('This claim expired or changed. Please try again.'));
    }
  };
  const settlePending = (config: TarotConfig, expected: PendingClaim, value: PendingClaim | null) => {
    const activeScope = current() && deployment.current === deploymentKey(config);
    const local = activeScope ? pendingRef.current : null;
    if (activeScope && local?.id !== expected.id) return;
    const existing = readPending(browserWindow, config, request.tokenId);
    if (existing?.id !== expected.id) return;
    updatePending(config, value);
  };
  const recordError = (error: unknown) => {
    if (!current()) return;
    const denied = isCredentialDenial(error);
    if (denied) {
      if (error instanceof TarotApiError && error.credentialRejected) settleNfcScan(browserWindow, request, false);
      setClaimFeedback(null);
    }
    const deadline = error instanceof TarotApiError ? error.retryAt ?? (error.status === 429 ? Date.now() + 60_000 : 0) : 0;
    retryAt.current = denied ? Math.max(retryAt.current, deadline) : deadline;
    if (denied || retryAt.current > Date.now()) {
      reconciliationEpoch.current++;
      walletWait.current?.controller.abort(error);
    }
    setRetryDeadline(retryAt.current > Date.now() ? retryAt.current : null);
    setState(previous => ({ ...previous, status: denied && !previous.status?.claimed ? null : previous.status, loading: false,
      error: error instanceof TarotApiError ? error.message : 'Couldn’t verify this Tarot claim. Please try again.' }));
  };
  const acceptChainObservation = (blockNumber: number, blockHash: string, claimed: boolean,
    observedBeforeRequest: ChainObservation | null): boolean => {
    const previous = chainObservation.current;
    const hash = blockHash.toLowerCase();
    if (previous && (blockNumber < previous.blockNumber || blockNumber === previous.blockNumber &&
      (hash === previous.blockHash && previous.claimed && !claimed ||
        previous !== observedBeforeRequest && hash !== previous.blockHash))) return false;
    chainObservation.current = { blockNumber, blockHash: hash, claimed };
    return true;
  };
  const acceptStatus = (status: TarotStatus, observedBeforeRequest: ChainObservation | null): boolean => {
    const scope = deploymentKey(status.config);
    if (deployment.current !== scope) {
      if (walletWait.current && walletWait.current.scope !== scope) {
        walletWait.current.controller.abort(new Error('This Tarot drop changed. Please reload and try again.'));
      }
      deployment.current = scope;
      chainObservation.current = null;
      pendingRef.current = null;
      setPending(null);
      setClaimFeedback(connectingClaim.current ? { identity, error: null } : null);
    }
    return acceptChainObservation(status.observedBlock, status.blockHash, status.claimed, observedBeforeRequest);
  };

  const refresh = useCallback(async (): Promise<TarotStatus | null> => {
    const controller = lifecycle.current;
    const initial = initialValidation.current;
    if (!controller || controller.signal.aborted || loading.current || retryAt.current > Date.now() ||
      latest.current.suspended || document.visibilityState === 'hidden' || !initial.succeeded && initial.permanentFailure) return null;
    loading.current = true;
    const epoch = reconciliationEpoch.current;
    const observation = chainObservation.current;
    setState(previous => ({ ...previous, loading: true }));
    try {
      let status: TarotStatus | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const saved = readSavedNfcCode(browserWindow, request.tokenId, request.testnet);
        const result = await tarotApi.status(request, controller.signal);
        controller.signal.throwIfAborted();
        if (latest.current.identity !== identity || reconciliationEpoch.current !== epoch) return null;
        if (readSavedNfcCode(browserWindow, request.tokenId, request.testnet) === saved) {
          status = result;
          break;
        }
      }
      if (!status) throw new DOMException('The saved NFC claim changed during validation.', 'AbortError');
      if (!acceptStatus(status, observation)) {
        setState(previous => ({ ...previous, loading: false }));
        return null;
      }
      initial.succeeded = true;
      settleNfcScan(browserWindow, request, true);
      setRetryDeadline(null);
      setState({ identity, status, loading: false, error: null });
      if (status.claimed) {
        setClaimFeedback(null);
        updatePending(status.config, null);
        walletWait.current?.controller.abort(new Error('This card has already been claimed.'));
      }
      else {
        const local = pendingRef.current;
        const recovered = readPending(browserWindow, status.config, request.tokenId);
        if (recovered && status.observedTimestamp > recovered.deadline) updatePending(status.config, null);
        else if (recovered !== local) updatePending(status.config, recovered);
      }
      retryAt.current = 0;
      return status;
    } catch (error) {
      if (!controller.signal.aborted && latest.current.identity === identity &&
        (reconciliationEpoch.current === epoch || isCredentialDenial(error))) {
        recordError(error);
        if (!initial.succeeded) {
          const retryable = canRetryInitialValidation(error);
          const delay = INITIAL_RETRY_DELAYS[Math.min(initial.failures++, INITIAL_RETRY_DELAYS.length - 1)];
          initial.permanentFailure = !retryable;
          if (retryable) {
            retryAt.current = Math.max(retryAt.current, Date.now() + delay);
          }
          setRetryDeadline(retryable ? retryAt.current : null);
        }
      }
      return null;
    } finally { if (lifecycle.current === controller) loading.current = false; }
  }, [identity]);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    initialValidation.current = { succeeded: false, failures: 0, permanentFailure: false };
    setRetryDeadline(null);
    pendingRef.current = null;
    deployment.current = null;
    chainObservation.current = null;
    retryAt.current = 0;
    loading.current = false;
    setPending(null);
    setClaimFeedback(null);
    setState({ identity, status: null, loading: true, error: null });
    void refresh();
    const focus = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    window.addEventListener('focus', focus);
    window.addEventListener('pageshow', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      controller.abort();
      window.removeEventListener('focus', focus);
      window.removeEventListener('pageshow', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [identity, refresh]);

  useEffect(() => {
    if (!suspended && !initialValidation.current.succeeded && initialValidation.current.failures === 0) void refresh();
  }, [suspended, refresh]);

  useEffect(() => {
    if (retryDeadline === null || suspended) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState === 'hidden' || latest.current.suspended) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (Date.now() < retryDeadline) schedule();
        else if (retryAt.current === retryDeadline) {
          retryAt.current = 0;
          setRetryDeadline(null);
          const initial = initialValidation.current;
          if (!initial.succeeded && !initial.permanentFailure && initial.failures <= INITIAL_RETRY_DELAYS.length) void refresh();
        }
      }, Math.min(2_147_483_647, Math.max(0, retryDeadline - Date.now())));
    };
    schedule();
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('focus', schedule);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', schedule);
      window.removeEventListener('focus', schedule);
    };
  }, [retryDeadline, suspended, refresh]);

  useEffect(() => {
    const controller = lifecycle.current;
    if (!pending || !currentStatus || currentStatus.claimed || !controller || suspended) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      if (!active || controller.signal.aborted) return;
      let epoch = reconciliationEpoch.current;
      try {
        if (retryAt.current <= Date.now() && document.visibilityState !== 'hidden') {
          const refreshed = await refresh();
          if (!active || controller.signal.aborted || !pendingRef.current) return;
          if (!refreshed) {
            timer = setTimeout(() => { void check(); }, Math.max(4_000, retryAt.current - Date.now()));
            return;
          }
          if (pending.transactionHash === null) {
            timer = setTimeout(() => { void check(); }, 4_000);
            return;
          }
          const observation = chainObservation.current;
          epoch = reconciliationEpoch.current;
          const result = await tarotApi.confirm({ ...request, wallet: pending.wallet, transactionHash: pending.transactionHash }, controller.signal);
          if (!active || controller.signal.aborted || !pendingRef.current || deployment.current !== deploymentKey(currentStatus.config)) return;
          if (reconciliationEpoch.current === epoch && result.status === 'confirmed' && result.blockNumber !== null && result.blockHash !== null &&
            acceptChainObservation(result.blockNumber, result.blockHash, true, observation)) {
            reconciliationEpoch.current++;
            setClaimFeedback(null);
            updatePending(currentStatus.config, null);
            setState(previous => ({ ...previous, status: previous.status ? { ...previous.status, claimed: true } : null, loading: false, error: null }));
            return;
          }
          if (reconciliationEpoch.current === epoch && result.status === 'failed' && chainObservation.current === observation) {
            updatePending(currentStatus.config, null);
            setClaimFeedback({ identity, error: 'The claim transaction failed. Please try again.' });
            setState(previous => ({ ...previous, error: 'The claim transaction failed. Please try again.' }));
            void refresh();
            return;
          }
          if (reconciliationEpoch.current === epoch && result.status === 'pending' && chainObservation.current === observation) {
            setClaimFeedback(previous => previous?.identity === identity && previous.transientConfirmation ? null : previous);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted && active && reconciliationEpoch.current === epoch) {
          recordError(error);
          if (!isCredentialDenial(error)) setClaimFeedback(previous => previous?.identity === identity &&
            previous.error && !previous.transientConfirmation ? previous : { identity,
              error: error instanceof TarotApiError ? error.message : 'Couldn’t verify this Tarot claim. Please try again.',
              transientConfirmation: true });
        }
      }
      if (active) timer = setTimeout(() => { void check(); }, Math.max(4_000, retryAt.current - Date.now()));
    };
    void check();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [identity, pending, currentStatus?.config.chainId, currentStatus?.config.contractAddress, currentStatus?.claimed, suspended, refresh]);

  const submit = async (): Promise<boolean> => {
    const controller = lifecycle.current;
    const config = currentStatus?.config;
    if (!controller || !config || !current()) return false;
    const wait = { id: null as string | null, scope: deploymentKey(config), controller: new AbortController() };
    walletWait.current = wait;
    let epoch = reconciliationEpoch.current;
    const operation = ethereumOperation(() => latest.current.identity === identity && !controller.signal.aborted &&
      !wait.controller.signal.aborted && deployment.current === wait.scope
      ? latest.current.wallet : { address: null, provider: null }, config);
    const signal = AbortSignal.any([controller.signal, operation.signal, wait.controller.signal]);
    try {
      await abortableEthereumOperation(operation.ensureNetwork(), signal);
      signal.throwIfAborted();
      epoch = ++reconciliationEpoch.current;
      const observation = chainObservation.current;
      const status = await tarotApi.status(request, signal);
      operation.assertCurrent();
      if (status.config.contractAddress !== config.contractAddress || status.config.chainId !== config.chainId ||
        status.config.testnet !== request.testnet || status.config.chainId !== tarotChainId(request.testnet) || !status.config.enabled) {
        throw new Error('This Tarot drop changed. Please reload and try again.');
      }
      if (!acceptStatus(status, observation)) {
        setState(previous => ({ ...previous, loading: false }));
        return false;
      }
      setState({ identity, status, loading: false, error: null });
      if (status.claimed) { setClaimFeedback(null); return true; }
      const authorization = await tarotApi.prepare({ ...request, wallet: operation.address }, config, signal);
      operation.assertCurrent();
      signal.throwIfAborted();
      let intent: PendingClaim | null = null;
      const submission = operation.send(authorization.transaction, () => {
        signal.throwIfAborted();
        if (authorization.expiresAtMs <= Date.now()) throw new Error('This claim expired. Please try again.');
        intent = { id: crypto.randomUUID(), wallet: operation.address, transactionHash: null, deadline: authorization.deadline };
        wait.id = intent.id;
        updatePending(config, intent);
      }).then(transactionHash => {
        if (intent) settlePending(config, intent, { ...intent, transactionHash });
      }, error => {
        if (intent && definiteEthereumSubmissionRejection(error)) {
          if (walletWait.current === wait) walletWait.current = null;
          settlePending(config, intent, null);
        }
        throw error;
      });
      await abortableEthereumOperation(submission, signal);
      if (current() && deployment.current === wait.scope) setClaimFeedback(null);
      return true;
    } catch (error) {
      if (current() && deployment.current === wait.scope && reconciliationEpoch.current === epoch) {
        if (error instanceof TarotApiError) recordError(error);
        else setState(previous => ({ ...previous, loading: false, error: ethereumWalletError(error) }));
        if (!isCredentialDenial(error)) setClaimFeedback({ identity,
          error: error instanceof TarotApiError ? error.message : ethereumWalletError(error) });
        if (error instanceof TarotApiError && error.status === 409) void refresh();
      }
      return false;
    } finally {
      if (walletWait.current === wait) walletWait.current = null;
      operation.dispose();
    }
  };

  const coolingDown = retryDeadline !== null && retryDeadline > Date.now();
  const action = useEthereumWalletAction({
    wallet, config: currentStatus?.config, blocked: Boolean(pending || currentStatus?.claimed || coolingDown), suspended,
    loadError: !currentStatus ? state.error : null,
  }, {
    canStart: () => Boolean(currentStatus && !state.loading && retryAt.current <= Date.now()),
    capture: () => {
      setClaimFeedback({ identity, error: null });
      return { data: identity };
    },
    isCurrent: attempt => attempt === latest.current.identity,
    validate: (attempt, options) => captureEthereumWalletActionConfig(attempt, options.config,
      'This Tarot drop changed. Please reload and try again.', CLAIMS_UNAVAILABLE) ||
      (ethereumWalletActionChanged(attempt, options.wallet) ? 'Your Ethereum wallet changed. Please try again.' : null),
    ready: () => Boolean(currentStatus && !currentStatus.claimed),
    submit,
    connectionError: 'Unable to connect your Ethereum wallet. Please try again.',
  });
  connectingClaim.current = action.connecting;

  const actionError = currentStatus?.config.enabled && action.error === CLAIMS_UNAVAILABLE ? null : action.error;
  const claimError = !currentStatus?.claimed && claimFeedback?.identity === identity ? claimFeedback.error || actionError : null;
  return { status: currentStatus, loading: state.loading, coolingDown, error: state.error || actionError || wallet.error, claimError,
    claim: action.start, cancel: action.cancel, connecting: action.connecting,
    pending: Boolean(pending) || action.pending,
    submitted: Boolean(pending && (!action.pending || pending.transactionHash !== null)), refresh };
}
