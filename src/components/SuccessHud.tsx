import { useCallback, useEffect, useRef, useState } from 'react';
import { FaCheck } from 'react-icons/fa6';

const SUCCESS_HUD_VISIBLE_MS = 2_300;
const SUCCESS_HUD_FADE_MS = 260;

export function useSuccessHud() {
  const [phase, setPhase] = useState<'visible' | 'fading' | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const fadeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announcementTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((message: string) => {
    if (fadeTimeoutRef.current) clearTimeout(fadeTimeoutRef.current);
    if (clearTimeoutRef.current) clearTimeout(clearTimeoutRef.current);
    if (announcementTimeoutRef.current) clearTimeout(announcementTimeoutRef.current);

    setPhase('visible');
    setAnnouncement('');
    announcementTimeoutRef.current = setTimeout(() => {
      setAnnouncement(message);
    }, 0);
    fadeTimeoutRef.current = setTimeout(() => {
      setPhase('fading');
      clearTimeoutRef.current = setTimeout(() => {
        setPhase(null);
      }, SUCCESS_HUD_FADE_MS);
    }, SUCCESS_HUD_VISIBLE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (fadeTimeoutRef.current) clearTimeout(fadeTimeoutRef.current);
      if (clearTimeoutRef.current) clearTimeout(clearTimeoutRef.current);
      if (announcementTimeoutRef.current) clearTimeout(announcementTimeoutRef.current);
    };
  }, []);

  return { phase, announcement, show };
}

interface SuccessHudProps {
  phase: 'visible' | 'fading' | null;
  announcement: string;
}

export function SuccessHud({ phase, announcement }: SuccessHudProps) {
  return (
    <>
      <div className="success-announcer" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {phase ? (
        <div
          className={`success-hud${phase === 'fading' ? ' success-hud--hidden' : ''}`}
          aria-hidden="true"
        >
          <FaCheck aria-hidden="true" focusable="false" />
        </div>
      ) : null}
    </>
  );
}
