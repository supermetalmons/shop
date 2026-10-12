import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

export function useStaticToModelHandoff(modelReady: boolean, resetKey: string | number) {
  const session = useMemo(() => ({}), [modelReady, resetKey]);
  const activeSessionRef = useRef<object | null>(null);
  const [presented, setPresented] = useState<object | null>(null);
  const frameRef = useRef<number | null>(null);
  const fallbackVisible = !modelReady || presented !== session;

  useLayoutEffect(() => {
    activeSessionRef.current = session;
    return () => {
      activeSessionRef.current = null;
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [session]);

  const onModelFrame = useCallback(() => {
    if (activeSessionRef.current !== session || !modelReady || !fallbackVisible || frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      if (activeSessionRef.current !== session) return;
      frameRef.current = window.requestAnimationFrame(() => {
        if (activeSessionRef.current !== session) return;
        frameRef.current = null;
        setPresented(session);
      });
    });
  }, [modelReady, fallbackVisible, session]);

  return { modelVisible: modelReady, fallbackVisible, onModelFrame };
}
