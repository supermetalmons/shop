import {
  useCallback,
  useEffect,
  useState
} from 'react';

export function useShopNotifications(normalizedCurrentPath: string, upcomingDrop: boolean, revealOverlayOpen: boolean) {
  const [notifyOpen, setNotifyOpen] = useState(false);
  const handleOpenNotify = useCallback(() => { if (!revealOverlayOpen) setNotifyOpen(true); }, [revealOverlayOpen]);
  const handleNotifyOpenChange = useCallback((open: boolean) => {
    setNotifyOpen(open);
    if (open || !upcomingDrop) return;
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0 }));
  }, [upcomingDrop]);
  useEffect(() => { setNotifyOpen(false); }, [normalizedCurrentPath]);
  return { notifyOpen, handleOpenNotify, handleNotifyOpenChange };
}
