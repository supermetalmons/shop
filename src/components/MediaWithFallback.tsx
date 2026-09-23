import { useCallback, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import { useColorSchemeImageSources } from './ColorSchemeImage';

export type PrimaryMediaControls = {
  ready: boolean;
  hidden: boolean;
  onLoading: () => void;
  onReady: () => void;
  onError: () => void;
};

type MediaWithFallbackProps = {
  imageSources: readonly string[];
  imageProps?: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'hidden' | 'onLoad' | 'onError'>;
  dropId?: string;
  renderPlaceholder: (hidden: boolean) => ReactNode;
  showPlaceholderWhileLoading?: boolean;
  renderPrimary?: (controls: PrimaryMediaControls) => ReactNode;
  primaryKey?: string;
};

type ImageStatus = 'loading' | 'ready' | 'failed';

export function MediaWithFallback({
  imageSources,
  imageProps,
  dropId,
  renderPlaceholder,
  showPlaceholderWhileLoading = false,
  renderPrimary,
  primaryKey,
}: MediaWithFallbackProps) {
  const sources = useColorSchemeImageSources(dropId, imageSources);
  const imageKey = JSON.stringify(sources);
  const [images, setImages] = useState<{ key: string; sources: readonly string[]; statuses: ImageStatus[] }>(() => ({
    key: imageKey,
    sources,
    statuses: sources.map(() => 'loading'),
  }));
  const [primary, setPrimary] = useState({ key: primaryKey, ready: false, hidden: false });

  if (images.key !== imageKey) {
    setImages({
      key: imageKey,
      sources,
      statuses: sources.map((src) => images.statuses[images.sources.indexOf(src)] ?? 'loading'),
    });
  }
  if (primary.key !== primaryKey) {
    setPrimary({ key: primaryKey, ready: false, hidden: primary.hidden });
  }

  const onLoading = useCallback(() => {
    setPrimary((previous) => previous.ready ? { ...previous, ready: false } : previous);
  }, []);
  const onReady = useCallback(() => {
    setPrimary((previous) => previous.ready && !previous.hidden
      ? previous
      : { ...previous, ready: true, hidden: false });
  }, []);
  const onError = useCallback(() => {
    setPrimary((previous) => !previous.ready && previous.hidden
      ? previous
      : { ...previous, ready: false, hidden: true });
  }, []);

  const updateImageStatus = (index: number, status: ImageStatus) => {
    setImages((previous) => {
      if (previous.key !== imageKey || previous.statuses[index] === status) return previous;
      const statuses = [...previous.statuses];
      statuses[index] = status;
      return { ...previous, statuses };
    });
  };
  const primaryReady = Boolean(renderPrimary && primary.ready);
  const activeImage = images.statuses.findIndex((status) => status !== 'failed');
  const placeholderHidden = primaryReady || (
    activeImage !== -1 && (images.statuses[activeImage] === 'ready' || !showPlaceholderWhileLoading)
  );

  return (
    <>
      {renderPrimary?.({ ready: primary.ready, hidden: primary.hidden, onLoading, onReady, onError })}
      {sources.map((src, index) => (
        <img
          {...imageProps}
          key={index}
          src={src}
          ref={(image) => {
            if (image?.complete) updateImageStatus(index, image.naturalWidth > 0 ? 'ready' : 'failed');
          }}
          hidden={primaryReady || index !== activeImage}
          onLoad={() => updateImageStatus(index, 'ready')}
          onError={() => updateImageStatus(index, 'failed')}
        />
      ))}
      {renderPlaceholder(placeholderHidden)}
    </>
  );
}
