import { useCallback, useEffect, useRef, useState } from 'react';

type AsyncSubmitOptions = {
  formatError: (error: unknown) => string;
  onPendingChange?: (pending: boolean) => void;
};

export function useAsyncSubmit(options: AsyncSubmitOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const mountedRef = useRef(false);
  const pendingRunRef = useRef<object | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    setPending(false);
    return () => {
      mountedRef.current = false;
      pendingRunRef.current = null;
      optionsRef.current.onPendingChange?.(false);
    };
  }, []);

  const isPending = useCallback(() => pendingRunRef.current !== null, []);
  const run = useCallback(async <T,>(task: () => Promise<T>, onSuccess?: (result: T) => void): Promise<void> => {
    if (!mountedRef.current || pendingRunRef.current) return;
    const submission = {};
    pendingRunRef.current = submission;
    const isCurrent = () => mountedRef.current && pendingRunRef.current === submission;
    setPending(true);
    setError(null);
    try {
      optionsRef.current.onPendingChange?.(true);
      const result = await task();
      if (isCurrent()) onSuccess?.(result);
    } catch (submitError) {
      if (isCurrent()) setError(optionsRef.current.formatError(submitError));
    } finally {
      if (isCurrent()) {
        pendingRunRef.current = null;
        setPending(false);
        optionsRef.current.onPendingChange?.(false);
      }
    }
  }, []);

  return { pending, error, setError, isPending, run };
}
