import { useCallback, useRef, useState, type SetStateAction } from 'react';
import {
  DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS,
  MI_NOTE_STICKER_EFFECT_CONTROLS,
  MI_NOTE_STICKER_EFFECTS_STORAGE_KEY,
  normalizeMiNoteStickerEffectSettings,
  parseMiNoteStickerEffect,
  serializeMiNoteStickerEffect,
  type MiNoteStickerEffectSettings,
} from '../lib/miNoteStickerEffects';

function readStickerEffects() {
  try {
    const serialized = window.localStorage.getItem(MI_NOTE_STICKER_EFFECTS_STORAGE_KEY);
    return {
      settings: serialized === null
        ? { ...DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS }
        : parseMiNoteStickerEffect(serialized),
      storageError: false,
    };
  } catch {
    return { settings: { ...DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS }, storageError: true };
  }
}

export function useMiNoteStickerEffects() {
  const [state, setState] = useState(readStickerEffects);
  const stateRef = useRef(state);

  const setSettings = useCallback((update: SetStateAction<MiNoteStickerEffectSettings>) => {
    const current = stateRef.current;
    const settings = normalizeMiNoteStickerEffectSettings(typeof update === 'function' ? update(current.settings) : update);
    if (!current.storageError && MI_NOTE_STICKER_EFFECT_CONTROLS.every(({ key }) => current.settings[key] === settings[key])) return;
    let storageError = false;
    try {
      window.localStorage.setItem(MI_NOTE_STICKER_EFFECTS_STORAGE_KEY, serializeMiNoteStickerEffect(settings));
    } catch {
      storageError = true;
    }
    const next = { settings, storageError };
    stateRef.current = next;
    setState(next);
  }, []);

  return { settings: state.settings, setSettings, storageError: state.storageError };
}
