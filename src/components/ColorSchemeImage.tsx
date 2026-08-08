import { useSyncExternalStore, type CSSProperties, type ImgHTMLAttributes } from 'react';
import { resolveColorSchemeImageSources } from '../lib/colorSchemeImages.ts';

const DARK_COLOR_SCHEME_QUERY = '(prefers-color-scheme: dark)';
const darkColorSchemeSubscribers = new Set<() => void>();
let darkColorSchemeMedia: MediaQueryList | undefined;

type ColorSchemeImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  dropId: string;
  src: string;
};

type ColorSchemeBackgroundStyle = CSSProperties & {
  '--color-scheme-image-light': string;
  '--color-scheme-image-dark': string;
};

function cssUrl(src: string): string {
  return `url(${JSON.stringify(src)})`;
}

function getDarkColorSchemeMedia(): MediaQueryList | undefined {
  if (darkColorSchemeMedia) return darkColorSchemeMedia;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
  darkColorSchemeMedia = window.matchMedia(DARK_COLOR_SCHEME_QUERY);
  return darkColorSchemeMedia;
}

function notifyDarkColorSchemeSubscribers() {
  darkColorSchemeSubscribers.forEach((subscriber) => subscriber());
}

function subscribeToDarkColorScheme(subscriber: () => void): () => void {
  const media = getDarkColorSchemeMedia();
  if (!media) return () => undefined;
  darkColorSchemeSubscribers.add(subscriber);
  if (darkColorSchemeSubscribers.size === 1) {
    media.addEventListener('change', notifyDarkColorSchemeSubscribers);
  }
  return () => {
    darkColorSchemeSubscribers.delete(subscriber);
    if (!darkColorSchemeSubscribers.size) {
      media.removeEventListener('change', notifyDarkColorSchemeSubscribers);
    }
  };
}

function darkColorSchemeSnapshot(): boolean {
  return getDarkColorSchemeMedia()?.matches ?? false;
}

function lightColorSchemeServerSnapshot(): boolean {
  return false;
}

export function colorSchemeBackgroundImageStyle(
  dropId: string,
  src: string,
): ColorSchemeBackgroundStyle {
  const sources = resolveColorSchemeImageSources(dropId, src);
  return {
    '--color-scheme-image-light': cssUrl(sources.lightSrc),
    '--color-scheme-image-dark': cssUrl(sources.darkSrc ?? sources.lightSrc),
  };
}

export function ColorSchemeImage({ dropId, src, ...imageProps }: ColorSchemeImageProps) {
  const sources = resolveColorSchemeImageSources(dropId, src);
  const darkColorScheme = useSyncExternalStore(
    subscribeToDarkColorScheme,
    darkColorSchemeSnapshot,
    lightColorSchemeServerSnapshot,
  );
  const resolvedSrc = darkColorScheme && sources.darkSrc ? sources.darkSrc : sources.lightSrc;
  return <img {...imageProps} src={resolvedSrc} />;
}
