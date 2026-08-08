import { useCallback, useEffect, useRef, useState } from 'react';
import { FaCheck } from 'react-icons/fa6';
import { BodyPortal } from './BackgroundBlurLayer';

const SUCCESS_HUD_VISIBLE_MS = 2_300;
const SUCCESS_HUD_FADE_MS = 260;

export function useSuccessHud(suspended = false) {
  const [phase, setPhase] = useState<'visible' | 'fading' | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const fadeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announcementTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;

  const cancelTimers = useCallback(() => {
    if (fadeTimeoutRef.current !== null) {
      clearTimeout(fadeTimeoutRef.current);
      fadeTimeoutRef.current = null;
    }
    if (clearTimeoutRef.current !== null) {
      clearTimeout(clearTimeoutRef.current);
      clearTimeoutRef.current = null;
    }
    if (announcementTimeoutRef.current !== null) {
      clearTimeout(announcementTimeoutRef.current);
      announcementTimeoutRef.current = null;
    }
  }, []);

  const clear = useCallback(() => {
    cancelTimers();
    setPhase(null);
    setAnnouncement('');
  }, [cancelTimers]);

  const show = useCallback(
    (message: string) => {
      if (suspendedRef.current) return;
      cancelTimers();

      setPhase('visible');
      setAnnouncement('');
      announcementTimeoutRef.current = setTimeout(() => {
        announcementTimeoutRef.current = null;
        if (suspendedRef.current) return;
        setAnnouncement(message);
      }, 0);
      fadeTimeoutRef.current = setTimeout(() => {
        fadeTimeoutRef.current = null;
        if (suspendedRef.current) return;
        setPhase('fading');
        clearTimeoutRef.current = setTimeout(() => {
          clearTimeoutRef.current = null;
          if (suspendedRef.current) return;
          setPhase(null);
          setAnnouncement('');
        }, SUCCESS_HUD_FADE_MS);
      }, SUCCESS_HUD_VISIBLE_MS);
    },
    [cancelTimers],
  );

  useEffect(() => {
    if (suspended) clear();
  }, [clear, suspended]);

  useEffect(() => {
    return cancelTimers;
  }, [cancelTimers]);

  return {
    phase: suspended ? null : phase,
    announcement: suspended ? '' : announcement,
    show,
  };
}

interface SuccessHudProps {
  phase: 'visible' | 'fading' | null;
  announcement: string;
  className?: string;
}

export function SuccessHud({ phase, announcement, className }: SuccessHudProps) {
  return (
    <BodyPortal>
      <div className="success-announcer" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {phase ? (
        <div
          className={`success-hud${phase === 'fading' ? ' success-hud--hidden' : ''}${
            className ? ` ${className}` : ''
          }`}
          aria-hidden="true"
          data-frosted-surface=""
        >
          <FaCheck aria-hidden="true" focusable="false" />
        </div>
      ) : null}
    </BodyPortal>
  );
}
