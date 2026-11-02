import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { EthereumApiError } from './api';
import { pre111kApi } from './pre111kApi';

const STORAGE_KEY = 'mons.shop.pre111k.access-code';
const STORAGE_EVENT = 'mons:pre111k-access';
const memory = new WeakMap<Window, string | null>();

function readCode(): string | null {
  if (memory.has(window)) return memory.get(window) ?? null;
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)?.trim().toUpperCase();
    return value && value.length <= 64 ? value : null;
  } catch { return null; }
}

function writeCode(code: string | null) {
  memory.set(window, code);
  try {
    if (code) window.localStorage.setItem(STORAGE_KEY, code);
    else window.localStorage.removeItem(STORAGE_KEY);
    memory.delete(window);
  } catch {}
  window.dispatchEvent(new window.Event(STORAGE_EVENT));
}

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(STORAGE_EVENT, listener);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(STORAGE_EVENT, listener);
  };
}

export function usePre111kAccess() {
  const code = useSyncExternalStore(subscribe, readCode, () => null);
  const [input, setInputValue] = useState(() => code ?? '');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const request = useRef<AbortController | null>(null);
  const verifiedCode = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); };
  }, []);

  const reject = useCallback((rejectedCode?: string) => {
    if (rejectedCode !== undefined && readCode() !== rejectedCode) return;
    request.current?.abort();
    verifiedCode.current = null;
    writeCode(null);
    setVerifying(false);
    setError('That code didn’t work. Try again.');
  }, []);

  const verify = useCallback(async (value: string, background: boolean) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setVerifying(true);
    setError(null);
    try {
      await pre111kApi.verifyAccess(value, controller.signal);
      if (!mounted.current || controller.signal.aborted || background && readCode() !== value) return;
      verifiedCode.current = value;
      if (!background) {
        writeCode(value);
        setInputValue(value);
      }
    } catch (cause) {
      if (!mounted.current || controller.signal.aborted || background && readCode() !== value) return;
      if (cause instanceof EthereumApiError && cause.code === 'unauthenticated') {
        if (background) reject(value);
        else setError('That code didn’t work. Try again.');
      } else if (!background) {
        setError('Couldn’t check your code. Please try again.');
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (mounted.current) setVerifying(false);
      }
    }
  }, [reject]);

  useEffect(() => {
    if (!code || verifiedCode.current === code) return;
    void verify(code, true);
    return () => { request.current?.abort(); };
  }, [code, verify]);

  const setInput = useCallback((value: string) => {
    request.current?.abort();
    setVerifying(false);
    setError(null);
    setInputValue(value.toUpperCase());
  }, []);

  const submit = async () => {
    if (request.current && !request.current.signal.aborted) return;
    const value = input.trim().toUpperCase();
    if (!value) { setError('Enter your secret code.'); return; }
    if (value.length > 64) { setError('That code didn’t work. Try again.'); return; }
    await verify(value, false);
  };

  return { code, input, setInput, verifying, error, submit, reject };
}
