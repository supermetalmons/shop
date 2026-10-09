import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach, mock } from 'node:test';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const player = {
  isInitialized: false,
  async initializeOnUserInteraction(_force: boolean) { player.isInitialized = true; },
  async preloadSound(_url: string) {},
  async playSound(_url: string, _volume: number, _isActive?: () => boolean) {},
};
const bridgeKey = '__miNotePackSoundsTest';
Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: player });
const imports = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/miNotePackSounds.ts') && specifier === './SoundPlayer') {
      return { url: 'test:mi-note-sound-player', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'test:mi-note-sound-player') {
      return { format: 'module', source: `export const soundPlayer = globalThis.${bridgeKey};`, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { MI_NOTE_PACK_SOUND_URLS, playMiNotePackSound, preloadMiNotePackSounds, unlockMiNotePackSounds } =
  await import('../src/lib/miNotePackSounds.ts');
imports.deregister();
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useRevealAssets } = await import('../src/shop/reveal/useRevealAssets.ts');
const { getFrontendDrop } = await import('../src/config/deployment.ts');
const { resolveDropContent } = await import('../src/lib/dropContent.ts');

beforeEach(() => {
  player.isInitialized = false;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(async () => { await preloadMiNotePackSounds(); cleanup(); mock.restoreAll(); });
after(() => { Reflect.deleteProperty(globalThis, bridgeKey); dom.window.close(); });

test('Mi Note sounds use the eight supplied clips and preload without unlocking audio', async () => {
  const preload = mock.method(player, 'preloadSound');
  const unlock = mock.method(player, 'initializeOnUserInteraction');
  assert.deepEqual(MI_NOTE_PACK_SOUND_URLS, {
    folderTap: 'https://cdn.lil.org/nft/mi_note_cards/sounds/folder_tap.mp3',
    stickerUnseal: 'https://cdn.lil.org/nft/mi_note_cards/sounds/sticker_unseal.mp3',
    folderOpen: 'https://cdn.lil.org/nft/mi_note_cards/sounds/folder_click_open.mp3',
    folderClose: 'https://cdn.lil.org/nft/mi_note_cards/sounds/folder_click_close.mp3',
    folderDragStart: 'https://cdn.lil.org/nft/mi_note_cards/sounds/folder_drag_start.mp3',
    folderDragEnd: 'https://cdn.lil.org/nft/mi_note_cards/sounds/folder_drag_end.mp3',
    cardPullout: 'https://cdn.lil.org/nft/mi_note_cards/sounds/card_pullout.mp3',
    cardPutback: 'https://cdn.lil.org/nft/mi_note_cards/sounds/card_putback.mp3',
  });
  await Promise.all([preloadMiNotePackSounds(), preloadMiNotePackSounds()]);
  assert.deepEqual(preload.mock.calls.map(call => call.arguments[0]), Object.values(MI_NOTE_PACK_SOUND_URLS));
  assert.equal(unlock.mock.callCount(), 0);
});

test('the first interaction unlocks immediately and plays after its preload at the shared volume', async () => {
  const pending = Promise.withResolvers<void>();
  const unlock = mock.method(player, 'initializeOnUserInteraction', async force => {
    assert.equal(force, true);
    await pending.promise;
    player.isInitialized = true;
  });
  const play = mock.method(player, 'playSound');
  const firstUnlock = unlockMiNotePackSounds();
  const secondUnlock = unlockMiNotePackSounds();
  assert.equal(unlock.mock.callCount(), 1);
  const sound = playMiNotePackSound('folderTap', () => true);
  assert.equal(play.mock.callCount(), 0);
  pending.resolve();
  await Promise.all([firstUnlock, secondUnlock, sound]);
  assert.deepEqual(play.mock.calls.map(call => call.arguments.slice(0, 2)), [[MI_NOTE_PACK_SOUND_URLS.folderTap, 0.42]]);
});

test('overlapping preload and playback serialize the initial fetch and audio decoding', async () => {
  const raw = Promise.withResolvers<void>();
  const decoded = Promise.withResolvers<void>();
  let tapPreloads = 0;
  let activeTapPreloads = 0;
  mock.method(player, 'preloadSound', async url => {
    if (url !== MI_NOTE_PACK_SOUND_URLS.folderTap) return;
    assert.equal(++activeTapPreloads, 1);
    await (++tapPreloads === 1 ? raw.promise : decoded.promise);
    activeTapPreloads -= 1;
  });
  const play = mock.method(player, 'playSound');
  const initialPreload = preloadMiNotePackSounds();
  await Promise.resolve();
  await unlockMiNotePackSounds();
  const taps = [playMiNotePackSound('folderTap', () => true), playMiNotePackSound('folderTap', () => true)];
  assert.equal(tapPreloads, 1);
  raw.resolve();
  await initialPreload;
  assert.equal(tapPreloads, 2);
  assert.equal(play.mock.callCount(), 0);
  decoded.resolve();
  await Promise.all(taps);
  assert.equal(tapPreloads, 2);
  assert.equal(play.mock.callCount(), 2);
});

test('the final tap and sticker unseal can play together without replacing either clip', async () => {
  await unlockMiNotePackSounds();
  await preloadMiNotePackSounds();
  const play = mock.method(player, 'playSound');
  await Promise.all([
    playMiNotePackSound('folderTap', () => true),
    playMiNotePackSound('stickerUnseal', () => true),
  ]);
  assert.deepEqual(play.mock.calls.map(call => call.arguments.slice(0, 2)), [
    [MI_NOTE_PACK_SOUND_URLS.folderTap, 0.42],
    [MI_NOTE_PACK_SOUND_URLS.stickerUnseal, 0.42],
  ]);
});

test('late audio preparation cannot play for a closed or hidden viewer', async () => {
  await unlockMiNotePackSounds();
  await preloadMiNotePackSounds();
  const pending = Promise.withResolvers<void>();
  mock.method(player, 'preloadSound', () => pending.promise);
  const play = mock.method(player, 'playSound');
  let active = true;
  const sound = playMiNotePackSound('cardPullout', () => active);
  await Promise.resolve();
  active = false;
  pending.resolve();
  await sound;
  assert.equal(play.mock.callCount(), 0);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  await playMiNotePackSound('cardPutback', () => true);
  assert.equal(play.mock.callCount(), 0);
});

test('a queued clip expires while preparation is pending', async () => {
  await unlockMiNotePackSounds();
  await preloadMiNotePackSounds();
  let now = 1000;
  mock.method(performance, 'now', () => now);
  const pending = Promise.withResolvers<void>();
  mock.method(player, 'preloadSound', () => pending.promise);
  const play = mock.method(player, 'playSound');
  const sound = playMiNotePackSound('folderOpen', () => true);
  await Promise.resolve();
  now += 251;
  pending.resolve();
  await sound;
  assert.equal(play.mock.callCount(), 0);
});

test('preload, unlock, and playback failures remain nonblocking and can retry', async () => {
  const preload = mock.method(player, 'preloadSound', async () => { throw new Error('Unavailable'); });
  await assert.doesNotReject(preloadMiNotePackSounds());
  const failedUnlock = mock.method(player, 'initializeOnUserInteraction', async () => { throw new Error('Locked'); });
  await assert.doesNotReject(unlockMiNotePackSounds());
  const play = mock.method(player, 'playSound', async () => { throw new Error('Interrupted'); });
  await playMiNotePackSound('folderTap', () => true);
  assert.equal(play.mock.callCount(), 0);
  failedUnlock.mock.restore();
  preload.mock.restore();
  await unlockMiNotePackSounds();
  await assert.doesNotReject(playMiNotePackSound('folderTap', () => true));
  assert.equal(play.mock.callCount(), 1);
});

for (const dropId of ['mi_note_cards', 'mi_note_cards_devnet']) {
  test(`${dropId} inventory preloads its eight sounds instead of generic reveal clips`, async () => {
    const preload = mock.method(player, 'preloadSound');
    const { result } = renderHook(() => useRevealAssets({ getDropConfig: getFrontendDrop, getDropContent: resolveDropContent }));
    await act(async () => { result.current.preloadRevealAssetsForPackMedia(dropId, 9); });
    assert.deepEqual(preload.mock.calls.map(call => call.arguments[0]), Object.values(MI_NOTE_PACK_SOUND_URLS));
  });
}
