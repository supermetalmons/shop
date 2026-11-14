import { useCallback, useRef } from 'react';
import { soundPlayer } from '../lib/SoundPlayer';

export function useSoundReadiness() {
  const soundInitPromiseRef = useRef<Promise<void> | null>(null);
  const ensureSoundReady = useCallback(() => {
    if (soundPlayer.isInitialized) return Promise.resolve();
    if (soundInitPromiseRef.current) return soundInitPromiseRef.current;
    const promise = soundPlayer.initializeOnUserInteraction(true).catch(() => undefined);
    soundInitPromiseRef.current = promise;
    void promise.then(() => {
      if (soundInitPromiseRef.current === promise) soundInitPromiseRef.current = null;
    });
    return promise;
  }, []);

  return { ensureSoundReady, soundInitPromiseRef };
}
