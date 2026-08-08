import { isDropFamily } from '../config/deployment.ts';
import {
  CLEAR_CARDS_CARD_CLEAN_BASE_URL,
  CLEAR_CARDS_CARD_CLEAN_DARK_BASE_URL,
} from '../config/dropMediaDefaults.ts';

export type ColorSchemeImageSources = {
  lightSrc: string;
  darkSrc?: string;
};

function pathAfterBase(url: string, baseUrl: string): string | undefined {
  const prefix = `${baseUrl}/`;
  return url.startsWith(prefix) ? url.slice(prefix.length) : undefined;
}

export function resolveColorSchemeImageSources(
  dropId: string,
  src: string,
): ColorSchemeImageSources {
  if (!isDropFamily(dropId, 'clear_cards')) return { lightSrc: src };

  const lightPath = pathAfterBase(src, CLEAR_CARDS_CARD_CLEAN_BASE_URL);
  const darkPath = pathAfterBase(src, CLEAR_CARDS_CARD_CLEAN_DARK_BASE_URL);
  const cardPath = lightPath ?? darkPath;
  if (cardPath === undefined) return { lightSrc: src };

  return {
    lightSrc: `${CLEAR_CARDS_CARD_CLEAN_BASE_URL}/${cardPath}`,
    darkSrc: `${CLEAR_CARDS_CARD_CLEAN_DARK_BASE_URL}/${cardPath}`,
  };
}
