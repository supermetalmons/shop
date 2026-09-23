import type { CSSProperties, ImgHTMLAttributes } from 'react';
import { resolveColorSchemeImageSources } from '../lib/colorSchemeImages.ts';
import { useDarkColorScheme } from '../hooks/useDarkColorScheme';

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

export function useColorSchemeImageSources(dropId: string | undefined, imageSources: readonly string[]): string[] {
  const darkColorScheme = useDarkColorScheme();
  return imageSources.map((src) => {
    if (!dropId) return src;
    const sources = resolveColorSchemeImageSources(dropId, src);
    return darkColorScheme && sources.darkSrc ? sources.darkSrc : sources.lightSrc;
  });
}

export function ColorSchemeImage({ dropId, src, ...imageProps }: ColorSchemeImageProps) {
  const [resolvedSrc] = useColorSchemeImageSources(dropId, [src]);
  return <img {...imageProps} src={resolvedSrc} />;
}
