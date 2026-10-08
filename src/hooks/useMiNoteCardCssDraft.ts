import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS,
  normalizeMiNoteCardCssEffectSettings,
  parseMiNoteCardCssEffectSettingsJson,
  serializeMiNoteCardCssEffectSettings,
  type MiNoteCardCssEffectSettings,
} from '../lib/miNoteCardCssEffects';

export const MI_NOTE_CARD_CSS_DRAFT_STORAGE_KEY = 'mons.shop:mi_note_cards_devnet:wip:css-effect:v1';

const defaultJson = serializeMiNoteCardCssEffectSettings(DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS);

export function useMiNoteCardCssDraft() {
  const [settings, setSettings] = useState<MiNoteCardCssEffectSettings>(() => {
    try {
      const source = window.localStorage.getItem(MI_NOTE_CARD_CSS_DRAFT_STORAGE_KEY);
      if (source) {
        const restored = parseMiNoteCardCssEffectSettingsJson(source);
        if (restored) return restored;
      }
    } catch {}
    return normalizeMiNoteCardCssEffectSettings(DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS);
  });

  useEffect(() => {
    try {
      const source = serializeMiNoteCardCssEffectSettings(settings);
      if (source === defaultJson) window.localStorage.removeItem(MI_NOTE_CARD_CSS_DRAFT_STORAGE_KEY);
      else window.localStorage.setItem(MI_NOTE_CARD_CSS_DRAFT_STORAGE_KEY, source);
    } catch {}
  }, [settings]);

  const updateSettings = useCallback((next: MiNoteCardCssEffectSettings) => {
    setSettings(normalizeMiNoteCardCssEffectSettings(next));
  }, []);
  const reset = useCallback(() => {
    setSettings(normalizeMiNoteCardCssEffectSettings(DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS));
  }, []);

  return { settings, setSettings: updateSettings, reset };
}
