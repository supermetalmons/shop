import { Component, lazy, Suspense, type ReactNode } from 'react';
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
  if (media.hidden) return null;

  return (
    <ShowcaseErrorBoundary onError={media.onError}>
      <Suspense fallback={null}>
        <MiNotePackShowcase media={media} />
      </Suspense>
    </ShowcaseErrorBoundary>
  );
}
