import { useEffect, useRef } from 'react';

const FORM_ID = '578237fe-8fb4-11f0-8bba-a35988c2be69';
const SCRIPT_SRC = 'https://eomail5.com/form/578237fe-8fb4-11f0-8bba-a35988c2be69.js';

export function EmailSubscribe() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
    if (existing) return;
    const script = document.createElement('script');
    script.async = true;
    script.src = SCRIPT_SRC;
    script.dataset.form = FORM_ID;
    containerRef.current.appendChild(script);
  }, []);

  return <div ref={containerRef} className="subscribe" aria-live="polite" />;
}
