import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import type { PrimaryMediaControls } from './MediaWithFallback';

const MiNotePackShowcase = lazy(() => import('./MiNotePackShowcase'));

class ShowcaseErrorBoundary extends Component<{ children: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function MiNotePackShowcasePreview({ media }: { media: PrimaryMediaControls }) {
  const [mountShowcase, setMountShowcase] = useState(false);

  useEffect(() => {
    if (media.hidden) return;
    let active = true;
    let timeoutId: number | undefined;
    const frameId = requestAnimationFrame(() => {
      timeoutId = window.setTimeout(() => {
        if (active) setMountShowcase(true);
      }, 0);
    });
    return () => {
      active = false;
      cancelAnimationFrame(frameId);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [media.hidden]);

  if (media.hidden || !mountShowcase) return null;

  return (
    <ShowcaseErrorBoundary onError={media.onError}>
      <Suspense fallback={null}>
        <MiNotePackShowcase media={media} />
      </Suspense>
    </ShowcaseErrorBoundary>
  );
}
