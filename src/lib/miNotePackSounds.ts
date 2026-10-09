import { soundPlayer } from './SoundPlayer';

const SOUND_BASE = 'https://cdn.lil.org/nft/mi_note_cards/sounds';
export const MI_NOTE_PACK_SOUND_URLS = {
  folderTap: `${SOUND_BASE}/folder_tap.mp3`,
  stickerUnseal: `${SOUND_BASE}/sticker_unseal.mp3`,
  folderOpen: `${SOUND_BASE}/folder_click_open.mp3`,
  folderClose: `${SOUND_BASE}/folder_click_close.mp3`,
  folderDragStart: `${SOUND_BASE}/folder_drag_start.mp3`,
  folderDragEnd: `${SOUND_BASE}/folder_drag_end.mp3`,
  cardPullout: `${SOUND_BASE}/card_pullout.mp3`,
  cardPutback: `${SOUND_BASE}/card_putback.mp3`,
} as const;

export type MiNotePackSound = keyof typeof MI_NOTE_PACK_SOUND_URLS;
const SOUND_VOLUME = 0.42;
const MAX_SOUND_DELAY_MS = 250;
const preparations = new Map<string, { decoding: boolean; promise: Promise<void> }>();
let initialization: Promise<void> | null = null;

function prepareSound(url: string): Promise<void> {
  const previous = preparations.get(url);
  const decoding = soundPlayer.isInitialized;
  if (previous && (!decoding || previous.decoding)) return previous.promise;
  const promise = (previous?.promise ?? Promise.resolve())
    .then(() => soundPlayer.preloadSound(url))
    .catch(() => undefined);
  const entry = { decoding, promise };
  preparations.set(url, entry);
  void promise.then(() => {
    if (preparations.get(url) === entry) preparations.delete(url);
  });
  return promise;
}

export async function preloadMiNotePackSounds(): Promise<void> {
  await Promise.all(Object.values(MI_NOTE_PACK_SOUND_URLS).map(prepareSound));
}

export function unlockMiNotePackSounds(): Promise<void> {
  if (initialization) return initialization;
  const promise = soundPlayer.initializeOnUserInteraction(true).catch(() => undefined);
  initialization = promise;
  void promise.then(() => {
    if (initialization === promise) initialization = null;
    void preloadMiNotePackSounds();
  });
  return promise;
}

export async function playMiNotePackSound(sound: MiNotePackSound, isActive: () => boolean): Promise<void> {
  const expiresAt = performance.now() + MAX_SOUND_DELAY_MS;
  const canPlay = () => isActive() && performance.now() <= expiresAt;
  if (!canPlay()) return;
  await initialization;
  if (!soundPlayer.isInitialized || !canPlay() || document.visibilityState !== 'visible') return;
  const url = MI_NOTE_PACK_SOUND_URLS[sound];
  await prepareSound(url);
  if (!canPlay() || document.visibilityState !== 'visible') return;
  await soundPlayer.playSound(url, SOUND_VOLUME, canPlay).catch(() => undefined);
}
