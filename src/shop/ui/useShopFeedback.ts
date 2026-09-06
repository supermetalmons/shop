import {
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react';
import { useSuccessHud } from '../../components/SuccessHud';
import { TOAST_FADE_MS, TOAST_VISIBLE_MS } from './feedback';

export function useShopFeedback(statusUiSuspended: boolean) {
  const statusUiSuspendedRef = useRef(statusUiSuspended);
  statusUiSuspendedRef.current = statusUiSuspended;
  const [toast, setToast] = useState<string | null>(null);

  const [toastVisible, setToastVisible] = useState(false);

  const toastFadeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toastClearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelToastTimers = useCallback(() => {
    if (toastFadeTimeoutRef.current !== null) {
      clearTimeout(toastFadeTimeoutRef.current);
      toastFadeTimeoutRef.current = null;
    }
    if (toastClearTimeoutRef.current !== null) {
      clearTimeout(toastClearTimeoutRef.current);
      toastClearTimeoutRef.current = null;
    }
  }, []);
  const clearToast = useCallback(() => {
    cancelToastTimers();
    setToastVisible(false);
    setToast(null);
  }, [cancelToastTimers]);
  const showToast = useCallback(
    (message: string) => {
      if (statusUiSuspendedRef.current) return;
      cancelToastTimers();
      setToast(message);
      setToastVisible(true);
      toastFadeTimeoutRef.current = setTimeout(() => {
        toastFadeTimeoutRef.current = null;
        setToastVisible(false);
      }, TOAST_VISIBLE_MS);
      toastClearTimeoutRef.current = setTimeout(() => {
        toastClearTimeoutRef.current = null;
        setToast(null);
      }, TOAST_VISIBLE_MS + TOAST_FADE_MS);
    },
    [cancelToastTimers],
  );
  useEffect(() => {
    if (statusUiSuspended) clearToast();
  }, [clearToast, statusUiSuspended]);
  useEffect(() => cancelToastTimers, [cancelToastTimers]);
  const { phase: successHudPhase, announcement: successAnnouncement, show: showSuccessHud } = useSuccessHud(statusUiSuspended);
  return { toast, toastVisible, showToast, showSuccessHud, successHudPhase, successAnnouncement };
}
